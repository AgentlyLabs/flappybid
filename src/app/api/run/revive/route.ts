import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom, isBanned } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { xHandleFrom } from "@/lib/x";
import { REVIVE_COST, REVIVES_PER_RUN } from "@/lib/economy";
import { spendForRevive, walletBalance } from "@/lib/wallet";

export const runtime = "nodejs";

// A revive costs coins, so it's a spend endpoint — same origin gate and rate
// limit as the rest of the run lifecycle. The wallet belongs to a connected X
// account, so a revive needs BOTH: an X session (whose wallet pays) and the
// device that started the run (so you can only revive your own in-flight run —
// the two come from the same browser). The coins are debited and the run's
// revive count bumped atomically in spend_for_revive; nothing here trusts a
// client-reported balance. The actual death frame is proven later, at submit,
// when the replay must reproduce a death at each claimed reviveFrame.
const allowed = makeLimiter({ windowMs: 60_000, max: 30, gapMs: 750 });

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let body: { runId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const runId = String(body.runId ?? "");
  if (!runId) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const deviceId = deviceIdFrom(req);
  if (!deviceId) {
    // no device cookie => this browser never started a run to revive
    return NextResponse.json({ error: "run not open" }, { status: 409 });
  }

  // the wallet is the X account's — no connection, no coins to spend
  const handle = await xHandleFrom(req);
  if (!handle) {
    return NextResponse.json(
      { error: "connect X to revive", needsX: true },
      { status: 403 }
    );
  }

  const client = db();
  interface ReviveRow {
    id: string;
    product_id: string;
    status: string;
    ip_hash: string | null;
    device_id?: string | null;
    revives_used?: number | null;
  }
  const base = "id, product_id, status, ip_hash";
  // peel columns a missing migration can't hold (revives_used, 0016
  // device_id) — but if revives_used is absent the economy isn't live yet
  const selects = [`${base}, device_id, revives_used`, `${base}, device_id`, base];
  let run: ReviveRow | null = null;
  let hasRevivesCol = false;
  for (let i = 0; i < selects.length; i++) {
    const res = await client
      .from("runs")
      .select(selects[i])
      .eq("id", runId)
      .maybeSingle();
    if (!res.error) {
      run = res.data as ReviveRow | null;
      hasRevivesCol = i === 0;
      break;
    }
  }
  if (!hasRevivesCol) {
    return NextResponse.json({ error: "revives aren't available" }, { status: 409 });
  }
  if (!run || run.status !== "open") {
    return NextResponse.json({ error: "run not open" }, { status: 409 });
  }

  // only the device that started the run can revive it
  if (!run.device_id || run.device_id !== deviceId) {
    return NextResponse.json({ error: "not your run" }, { status: 403 });
  }

  // banned since the run started
  if (
    await isBanned(client, run.product_id, {
      ipHashes: [ipHash, run.ip_hash],
      deviceIds: [deviceId],
    })
  ) {
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }

  const newBalance = await spendForRevive(
    client,
    handle,
    runId,
    REVIVE_COST,
    REVIVES_PER_RUN
  );
  if (newBalance === null) {
    // couldn't grant it — tell the player which: out of coins, or out of
    // revives for this run
    const balance = await walletBalance(client, handle);
    if (balance < REVIVE_COST) {
      return NextResponse.json(
        { error: "not enough coins", balance },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: "no revives left for this run", balance },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, balance: newBalance });
}
