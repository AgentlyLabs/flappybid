import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { recomputeDailyBest } from "@/lib/board";
import { utcDay, utcYesterday } from "@/lib/day";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only manual bans, the only way bans are created — auto-banning is
// off (see lib/ban.ts); cheated runs keep their evidence in cheat_reason for
// the owner to assess before pulling this trigger. Two shapes:
//
//   { productId }                    — blacklist the ENTRY and wipe it off
//                                      today's board
//   { runId } or
//   { productId, target: "device" }  — blacklist the DEVICE behind a run
//                                      (its ip_hash + fb_device cookie); the
//                                      entry itself is untouched. This is
//                                      the right tool when a hostile
//                                      submitter tops an innocent entry:
//                                      product ids are public, so the bot
//                                      run proves the submitter cheated,
//                                      never the entry it flew "for".

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Unban: delete the blacklist row(s) so the entry/device can start and
// submit again. A device ban lands as two rows (ip_hash + device_id) from
// one click, linked by run_id — lift both together, or the unban silently
// half-holds. Runs the ban rejected stay rejected: they're evidence, and
// restoring scores is a separate, deliberate act (see
// scripts/restore-mismatch-runs.mts for the shape of it).

export async function DELETE(req: NextRequest) {
  if (!isAdminHandle(await xHandleFrom(req))) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let banId = "";
  try {
    banId = String((await req.json()).banId ?? "");
  } catch {
    // fall through to the validation error
  }
  if (!UUID_RE.test(banId)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const client = db();
    const { data: ban } = await client
      .from("bans")
      .select("id, run_id")
      .eq("id", banId)
      .maybeSingle();
    if (!ban) {
      return NextResponse.json({ error: "ban not found" }, { status: 404 });
    }
    const { error } = await (ban.run_id
      ? client.from("bans").delete().or(`id.eq.${banId},run_id.eq.${ban.run_id}`)
      : client.from("bans").delete().eq("id", banId));
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "unban failed" }, { status: 500 });
  }
}

interface RunIds {
  id: string;
  ip_hash: string | null;
  device_id?: string | null;
}

export async function POST(req: NextRequest) {
  const handle = await xHandleFrom(req);
  if (!isAdminHandle(handle)) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let body: { productId?: unknown; runId?: unknown; target?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // fall through to the validation error
  }
  const productId = String(body.productId ?? "");
  const runId = String(body.runId ?? "");
  const deviceBan = UUID_RE.test(runId) || body.target === "device";
  if (!deviceBan && !UUID_RE.test(productId)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (deviceBan && !UUID_RE.test(runId) && !UUID_RE.test(productId)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const client = db();

    if (!deviceBan) {
      await Promise.all([
        client.from("bans").upsert(
          { product_id: productId, reason: `manual ban by @${handle}` },
          { onConflict: "product_id", ignoreDuplicates: true }
        ),
        client
          .from("daily_scores")
          .delete()
          .eq("product_id", productId)
          .eq("day", utcDay()),
      ]);
      return NextResponse.json({ ok: true });
    }

    // Resolve the run whose device gets banned: the one named directly, or
    // the entry's best scored run today (the run the board chip judged).
    // The device_id column is missing on databases predating it — retry without
    // it and ban the ip_hash alone.
    let run: RunIds | null = null;
    let query = client.from("runs").select("id, ip_hash, device_id").limit(1);
    let bare = client.from("runs").select("id, ip_hash").limit(1);
    if (UUID_RE.test(runId)) {
      query = query.eq("id", runId);
      bare = bare.eq("id", runId);
    } else {
      const best = { day: utcDay(), status: "scored" };
      query = query.match({ product_id: productId, ...best }).order("score", { ascending: false });
      bare = bare.match({ product_id: productId, ...best }).order("score", { ascending: false });
    }
    const res = await query.maybeSingle();
    run = res.error ? (await bare.maybeSingle()).data : (res.data as RunIds | null);
    if (!run) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    if (!run.ip_hash && !run.device_id) {
      return NextResponse.json(
        { error: "run carries no device identity to ban" },
        { status: 422 }
      );
    }

    const reason = `manual device ban by @${handle} (run ${run.id})`;
    await Promise.all([
      run.ip_hash
        ? client.from("bans").upsert(
            { ip_hash: run.ip_hash, run_id: run.id, reason },
            { onConflict: "ip_hash", ignoreDuplicates: true }
          )
        : null,
      run.device_id
        ? client.from("bans").upsert(
            { device_id: run.device_id, run_id: run.id, reason },
            { onConflict: "device_id", ignoreDuplicates: true }
          )
        : null,
    ]);

    // The ban only stops FUTURE starts and submits — the device's scores
    // are already folded into the board, where they'd keep squatting (and
    // could still be crowned: the close never re-reads bans). Disqualify
    // its scored runs on the days that can still be won and recompute each
    // touched entry's best, so the verdict is visible the moment the
    // dashboard refreshes.
    const conds = [
      run.ip_hash ? `ip_hash.eq.${run.ip_hash}` : null,
      run.device_id ? `device_id.eq.${run.device_id}` : null,
    ].filter(Boolean) as string[];
    const { data: squatting } = await client
      .from("runs")
      .select("id, product_id, day")
      .or(conds.join(","))
      .in("day", [utcDay(), utcYesterday()])
      .eq("status", "scored");
    if (squatting?.length) {
      await client
        .from("runs")
        .update({ status: "rejected", cheat_reason: reason })
        .in("id", squatting.map((r) => r.id));
      const touched = new Map(
        squatting.map((r) => [`${r.product_id}|${r.day}`, r])
      );
      for (const r of touched.values()) {
        await recomputeDailyBest(client, r.product_id, r.day);
      }
    }
    return NextResponse.json({ ok: true, runsRemoved: squatting?.length ?? 0 });
  } catch {
    return NextResponse.json({ error: "ban failed" }, { status: 500 });
  }
}
