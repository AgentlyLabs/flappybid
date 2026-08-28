import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { utcDay } from "@/lib/day";
import { recomputeDailyBest } from "@/lib/board";

export const runtime = "nodejs";

// the grant is one row per device per day, so anything past a few clicks a
// minute is a script poking the endpoint
const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 1_000 });

// Claim the X share boost: the end-game button that opens the X composer also
// lands here, marking this device as 2x for today. The click is the grant —
// there's no way to verify the post actually happened — same deal as
// /api/boost for Product Hunt. Because the click comes AFTER a run was
// scored, the grant is also applied backwards over today's runs (migration
// the grant_x_share_boost): "share your card" has to double the very score
// on the card, not just the next one.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the boost is already yours" },
      { status: 429 }
    );
  }

  const day = utcDay();
  const client = db();
  // remember which device claimed it, when the cookie exists — pure signal
  // for review, the (ip_hash, day) grant key is unchanged
  const deviceId = deviceIdFrom(req);
  const { error } = await client
    .from("x_shares")
    .upsert(
      { ip_hash: ipHash, day, ...(deviceId ? { device_id: deviceId } : {}) },
      { onConflict: "ip_hash,day", ignoreDuplicates: true }
    );
  if (error) {
    // table missing (older database) or a write hiccup — the
    // composer already opened, so just say so honestly
    return NextResponse.json({ error: "could not record the boost" }, { status: 500 });
  }

  // retroactive half: double today's already-scored runs from this device,
  // then refold each touched product's daily best. boost = 1 inside the
  // function makes replays (and the self-heal re-fire) no-ops. An error here
  // (function missing) still leaves the grant in place for future runs.
  const { data: touched } = await client.rpc("grant_x_share_boost", {
    p_ip_hash: ipHash,
    p_day: day,
  });
  const productIds = [
    ...new Set(((touched ?? []) as { pid: string }[]).map((r) => r.pid)),
  ];
  for (const pid of productIds) {
    await recomputeDailyBest(client, pid, day);
  }

  return NextResponse.json({ active: true, day });
}
