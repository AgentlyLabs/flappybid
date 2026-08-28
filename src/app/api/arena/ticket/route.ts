import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { duelBanned } from "@/lib/duels";
import { HUMAN_COOKIE, humanCheckEnabled, isHumanPass } from "@/lib/human";
import { xHandleFrom } from "@/lib/x";
import { mintArenaTicket } from "@/server/hub";
import { ARENA_VERSION } from "@/game/arena";

export const runtime = "nodejs";

const allowed = makeLimiter({ windowMs: 60_000, max: 20, gapMs: 400 });

// The arena door. The websocket hub trusts nothing but tickets minted
// here, so every entry passes the full stack: origin, rate limit, the
// Turnstile day-pass, and the ban list. With stakes on the horizon this
// is the choke point to harden further (see hub.ts for the in-fight side).
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the arena gate has a queue" },
      { status: 429 }
    );
  }
  if (
    humanCheckEnabled() &&
    !isHumanPass(req.cookies.get(HUMAN_COOKIE)?.value, ipHash)
  ) {
    return NextResponse.json(
      { error: "quick human check needed", humanCheck: true },
      { status: 403 }
    );
  }
  const deviceId = deviceIdFrom(req);
  if (await duelBanned(db(), [ipHash], [deviceId])) {
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }
  // the verified X handle rides inside the signed ticket — the hub gates
  // PvP seats on it (ringside and the bot stay open to all) and the duel
  // board records wins under it
  const handle = await xHandleFrom(req);
  return NextResponse.json({
    ticket: mintArenaTicket(ipHash, handle ?? ""),
    version: ARENA_VERSION,
    handle,
  });
}
