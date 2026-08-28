import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { recomputeDailyBest } from "@/lib/board";
import { championCandidate, ensureFinalized } from "@/lib/close";
import { utcDay } from "@/lib/day";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Champion review verdicts. Approving crowns the day on the spot (the close
// is gated on it); rejecting disqualifies that one run and recomputes the
// entry's daily best, so the next candidate surfaces for review. Rejection
// deliberately bans nothing — entries are ban-by-proxy attackable, so
// device/entry bans stay a separate manual call.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const handle = await xHandleFrom(req);
  if (!isAdminHandle(handle)) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let runId = "";
  let verdict = "";
  try {
    const body = await req.json();
    runId = String(body.runId ?? "");
    verdict = String(body.verdict ?? "");
  } catch {
    // fall through to the validation error
  }
  if (!UUID_RE.test(runId) || !["approve", "reject"].includes(verdict)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const client = db();
  const { data: run } = await client
    .from("runs")
    .select("id, product_id, day, status, review, cheat_reason")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.status !== "scored") {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  if (verdict === "approve") {
    // only completed days: today's top can still be displaced, and approval
    // must bind to the run that actually gets crowned
    if (run.day >= utcDay()) {
      return NextResponse.json(
        { error: "the day is still running" },
        { status: 409 }
      );
    }
    // a higher run may have landed inside the post-midnight grace window
    const candidate = await championCandidate(run.day);
    if (candidate?.run?.id !== run.id) {
      return NextResponse.json(
        { error: "no longer the top run — refresh and review again" },
        { status: 409 }
      );
    }
    await client
      .from("runs")
      .update({
        review: "approved",
        reviewed_by: handle,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    await ensureFinalized(run.day);
    return NextResponse.json({ ok: true, crowned: run.day });
  }

  // reject: disqualify the run, keep the original behavioral tell around
  const reason = [
    `rejected in champion review by @${handle}`,
    run.cheat_reason,
  ]
    .filter(Boolean)
    .join(" — tell: ");
  await client
    .from("runs")
    .update({
      status: "cheated",
      review: "rejected",
      reviewed_by: handle,
      reviewed_at: new Date().toISOString(),
      cheat_reason: reason,
    })
    .eq("id", run.id);

  // the entry's daily best may have been this run — recompute from what's
  // left, by the board's own currency (effective = raw × PH boost)
  await recomputeDailyBest(client, run.product_id, run.day);

  return NextResponse.json({ ok: true });
}
