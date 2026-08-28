import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import {
  duelBanned,
  duelNickname,
  duelStartMs,
  verdictWord,
  type DuelRow,
} from "@/lib/duels";
import {
  DUEL_VERSION,
  duelReplay,
  normalizeRuleset,
  validateScript,
} from "@/game/duel";
import { TICK_HZ } from "@/game/constants";

export const runtime = "nodejs";

const allowed = makeLimiter({ windowMs: 60_000, max: 4, gapMs: 3_000 });

// Accept a ghost's challenge: the server merges both scripts through the
// deterministic duel sim and stores the verdict. Neither side's claim is
// ever trusted — the fight the acceptor watches is the same replay anyone
// can re-run from the stored scripts.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — one fight at a time" },
      { status: 429 }
    );
  }

  let body: {
    duelId?: unknown;
    nickname?: unknown;
    script?: unknown;
    duelVersion?: unknown;
    startToken?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (Number(body.duelVersion) !== DUEL_VERSION) {
    return NextResponse.json(
      { error: "the arena was updated — refresh the page and fly again" },
      { status: 409 }
    );
  }
  const duelId = String(body.duelId ?? "");
  if (!duelId) {
    return NextResponse.json({ error: "duelId required" }, { status: 400 });
  }
  const nickname = duelNickname(body.nickname);
  if (!nickname) {
    return NextResponse.json(
      { error: "bird name: 3–12 letters, numbers, - or _" },
      { status: 400 }
    );
  }
  if (!validateScript(body.script)) {
    return NextResponse.json({ error: "bad fight script" }, { status: 400 });
  }
  const script = body.script;

  const startMs = duelStartMs(body.startToken, ipHash);
  if (startMs === null) {
    return NextResponse.json(
      { error: "recording session expired — fly it again" },
      { status: 409 }
    );
  }
  const lastFrame = script.length ? script[script.length - 2] : 0;
  const elapsedSec = (Date.now() - startMs) / 1000;
  if (elapsedSec < (lastFrame / TICK_HZ) * 0.85 - 2) {
    return NextResponse.json(
      { error: "script arrived faster than real time", rejected: true },
      { status: 422 }
    );
  }

  const client = db();
  const deviceId = deviceIdFrom(req);
  if (await duelBanned(client, [ipHash], [deviceId])) {
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }

  const { data: duel } = await client
    .from("duels")
    .select(
      "id, status, mode, nickname, taunt, ruleset, script, duel_version, wins, losses, draws, expires_at, created_at"
    )
    .eq("id", duelId)
    .maybeSingle<DuelRow>();
  if (!duel) {
    return NextResponse.json({ error: "unknown duel" }, { status: 404 });
  }
  if (duel.status !== "open" || Date.parse(duel.expires_at) < Date.now()) {
    return NextResponse.json(
      { error: "this ghost has left the arena" },
      { status: 409 }
    );
  }
  if (duel.duel_version !== DUEL_VERSION) {
    return NextResponse.json(
      { error: "this ghost fought under older arena rules — it's retired" },
      { status: 409 }
    );
  }

  // best-effort one accept per device per ghost (the ph_votes precedent —
  // honest people get one shot, and that's what makes records mean something)
  const { data: prior } = await client
    .from("duel_matches")
    .select("id")
    .eq("duel_id", duel.id)
    .eq("ip_hash", ipHash)
    .limit(1);
  if ((prior?.length ?? 0) > 0) {
    return NextResponse.json(
      { error: "you already fought this ghost — the record stands" },
      { status: 409 }
    );
  }

  // the fight: ghost is always fighter A, acceptor fighter B
  const ruleset = normalizeRuleset(duel.ruleset);
  const result = duelReplay(duel.script, script, ruleset);
  const winner = verdictWord(result.winner);

  const { data: match, error: matchErr } = await client
    .from("duel_matches")
    .insert({
      duel_id: duel.id,
      nickname,
      script,
      ip_hash: ipHash,
      device_id: deviceId,
      winner,
      ko: result.koWin,
      frames: result.frames,
      ghost_hp: result.hp[0],
      challenger_hp: result.hp[1],
      ghost_dmg: result.dmg[0],
      challenger_dmg: result.dmg[1],
    })
    .select("id")
    .single();
  if (matchErr || !match) {
    return NextResponse.json({ error: "could not record the fight" }, { status: 500 });
  }

  // tally on the ghost; first blood closes the challenge after one fight
  await client
    .from("duels")
    .update({
      wins: duel.wins + (winner === "ghost" ? 1 : 0),
      losses: duel.losses + (winner === "challenger" ? 1 : 0),
      draws: duel.draws + (winner === "draw" ? 1 : 0),
      ...(duel.mode === "first_blood" ? { status: "closed" } : {}),
    })
    .eq("id", duel.id);

  // the acceptor gets the ghost's script now — the fight is over, and the
  // client replays the merge locally for the reveal
  return NextResponse.json({
    matchId: match.id,
    verdict: {
      winner,
      ko: result.koWin,
      frames: result.frames,
      ghostHp: result.hp[0],
      challengerHp: result.hp[1],
      ghostDmg: result.dmg[0],
      challengerDmg: result.dmg[1],
    },
    ghost: {
      nickname: duel.nickname,
      taunt: duel.taunt,
      script: duel.script,
    },
    ruleset,
  });
}
