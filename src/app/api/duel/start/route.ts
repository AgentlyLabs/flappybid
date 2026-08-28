import { NextRequest, NextResponse } from "next/server";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { HUMAN_COOKIE, humanCheckEnabled, isHumanPass } from "@/lib/human";
import { mintDuelStart } from "@/lib/duels";
import { DUEL_VERSION } from "@/game/duel";

export const runtime = "nodejs";

const allowed = makeLimiter({ windowMs: 60_000, max: 20, gapMs: 1_000 });

// Recording a fight script starts here: a signed timestamp the poster or
// acceptor must return with their script, so a script can't take less wall
// clock than sim time (the duel version of runs.started_at — stateless,
// nothing is stored until a script is actually submitted).
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the pit isn't going anywhere" },
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
  return NextResponse.json({
    t: mintDuelStart(ipHash),
    duelVersion: DUEL_VERSION,
  });
}
