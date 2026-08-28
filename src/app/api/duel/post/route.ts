import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import {
  duelBanned,
  duelExpiryHours,
  duelNickname,
  duelStartMs,
  duelTaunt,
} from "@/lib/duels";
import {
  DUEL_VERSION,
  normalizeRuleset,
  validateScript,
} from "@/game/duel";
import { TICK_HZ } from "@/game/constants";

export const runtime = "nodejs";

// Posting means having flown a 30s+ recording first, so even a keen
// challenger can't sustain more than a couple a minute
const allowed = makeLimiter({ windowMs: 60_000, max: 4, gapMs: 3_000 });

// Post a ghost: the recorded fight script becomes an open challenge on the
// duel board. The script is validated structurally and against real time,
// but there's no score to verify — the fight (and its verdict) only exists
// when someone accepts and the server merges both scripts.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — one ghost at a time" },
      { status: 429 }
    );
  }

  let body: {
    nickname?: unknown;
    taunt?: unknown;
    ruleset?: unknown;
    mode?: unknown;
    expiryHours?: unknown;
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
  const nickname = duelNickname(body.nickname);
  if (!nickname) {
    return NextResponse.json(
      { error: "bird name: 3–12 letters, numbers, - or _" },
      { status: 400 }
    );
  }
  const expiryHours = duelExpiryHours(body.expiryHours);
  if (!expiryHours) {
    return NextResponse.json({ error: "bad expiry" }, { status: 400 });
  }
  const mode = body.mode === "first_blood" ? "first_blood" : "gauntlet";
  if (!validateScript(body.script)) {
    return NextResponse.json({ error: "bad fight script" }, { status: 400 });
  }
  const script = body.script;

  // real-time check, same rule as run submit: the recording must have taken
  // at least its own sim duration in wall clock
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

  const ownerToken = randomBytes(12).toString("hex");
  const { data: duel, error } = await client
    .from("duels")
    .insert({
      nickname,
      taunt: duelTaunt(body.taunt),
      ruleset: normalizeRuleset(body.ruleset),
      mode,
      script,
      duel_version: DUEL_VERSION,
      owner_token: ownerToken,
      ip_hash: ipHash,
      device_id: deviceId,
      expires_at: new Date(Date.now() + expiryHours * 3_600_000).toISOString(),
    })
    .select("id, expires_at")
    .single();
  if (error || !duel) {
    return NextResponse.json({ error: "could not post the ghost" }, { status: 500 });
  }

  // ownerToken stays in the poster's browser — it's the only way to
  // withdraw the ghost later (no accounts)
  return NextResponse.json({
    duelId: duel.id,
    ownerToken,
    expiresAt: duel.expires_at,
  });
}
