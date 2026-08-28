import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  CHECKPOINT_EVERY_FRAMES,
  MAX_CHECKPOINTS,
  inputsHash,
  type CheckpointRow,
} from "@/game/checkpoint";
import { analyzeRun } from "@/game/detect";
import { MAPS, isMapId } from "@/game/maps";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom, isBanned } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { boostFor } from "@/lib/boost";
import { MAX_REVIVES } from "@/lib/economy";
import {
  MAX_FLAPS,
  MAX_SHOTS,
  SIM_VERSION,
  TICK_HZ,
} from "@/game/constants";

export const runtime = "nodejs";

// Every submit pairs with a start, so the same ceiling applies — this stops
// a script from hammering replays at the verifier
const allowed = makeLimiter({ windowMs: 60_000, max: 30, gapMs: 750 });

// A strictly increasing list of frame indices — the shape of every input
// stream the client can send (flaps, and shots on combat maps).
function isFrameList(v: unknown, max: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length <= max &&
    v.every(
      (f, i) =>
        Number.isSafeInteger(f) &&
        f >= 0 &&
        (i === 0 || f > (v as number[])[i - 1])
    )
  );
}

// The client sends only the frame indices of its inputs (flaps, plus shots
// on combat maps). We replay the exact same deterministic sim from the
// server-issued seed and derive the score ourselves. A claimed score that
// the replay can't reproduce is rejected.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — one run at a time" },
      { status: 429 }
    );
  }

  let body: {
    runId?: string;
    flapFrames?: unknown;
    shootFrames?: unknown;
    reviveFrames?: unknown;
    claimedScore?: unknown;
    simVersion?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const runId = String(body.runId ?? "");
  const claimedScore = Number(body.claimedScore);

  if (!runId || !Number.isInteger(claimedScore) || claimedScore < 0) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  if (!isFrameList(body.flapFrames, MAX_FLAPS)) {
    return NextResponse.json({ error: "bad flap data" }, { status: 400 });
  }
  const flaps = body.flapFrames;
  // absent = a run with no shots (every pre-combat client)
  if (body.shootFrames !== undefined && !isFrameList(body.shootFrames, MAX_SHOTS)) {
    return NextResponse.json({ error: "bad shot data" }, { status: 400 });
  }
  const shots = body.shootFrames ?? [];
  // absent = a run that was never revived (every pre-revive client)
  if (
    body.reviveFrames !== undefined &&
    !isFrameList(body.reviveFrames, MAX_REVIVES)
  ) {
    return NextResponse.json({ error: "bad revive data" }, { status: 400 });
  }
  const revives = body.reviveFrames ?? [];

  const client = db();
  interface RunRow {
    id: string;
    product_id: string;
    day: string;
    seed: number | string;
    status: string;
    started_at: string;
    ip_hash: string | null;
    map?: string | null;
    device_id?: string | null;
    checkpoints?: unknown;
    cp_nonce?: string | null;
    revives_used?: number | null;
  }
  const cols = "id, product_id, day, seed, status, started_at, ip_hash";
  const cpCols = `${cols}, map, device_id, checkpoints, cp_nonce`;
  // newest schema first; each retry peels off the columns a missing
  // migration can't hold (revives_used, checkpoints, 0016
  // device_id, map). revives_used peels on its own layer ABOVE the
  // checkpoint columns so a missing column doesn't also drop live-checkpoint
  // verification.
  const selects = [
    `${cpCols}, revives_used`,
    cpCols,
    `${cols}, map, device_id`,
    `${cols}, map`,
    cols,
  ];
  let run: RunRow | null = null;
  for (const s of selects) {
    const res = await client
      .from("runs")
      .select(s)
      .eq("id", runId)
      .maybeSingle();
    if (!res.error) {
      run = res.data as RunRow | null;
      break;
    }
  }
  if (!run || run.status !== "open") {
    return NextResponse.json({ error: "run not open" }, { status: 409 });
  }

  const reject = async (reason: string, score: number | null = null) => {
    await client
      .from("runs")
      .update({ status: "rejected", score, submitted_at: new Date().toISOString() })
      .eq("id", run.id);
    return NextResponse.json({ error: reason, rejected: true }, { status: 422 });
  };

  // blacklisted entry or device (possibly banned since this run started)
  const deviceId = deviceIdFrom(req);
  if (
    await isBanned(client, run.product_id, {
      ipHashes: [ipHash, run.ip_hash],
      deviceIds: [deviceId, run.device_id],
    })
  ) {
    await client
      .from("runs")
      .update({ status: "rejected", submitted_at: new Date().toISOString() })
      .eq("id", run.id);
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }

  // stale bundle from before a sim change: its replay legitimately can't
  // match ours. That's a refresh problem, not cheating — bail before any
  // cheat verdict can fire (a mismatch would otherwise mark the run cheated).
  if (Number(body.simVersion) !== SIM_VERSION) {
    return reject("the game was updated — refresh the page and fly again");
  }

  // A cheat verdict disqualifies the RUN — it never bans. Auto-banning is
  // off entirely: product ids are public and anyone can play "for" any
  // entry, so a hostile script once got innocent entries auto-banned by
  // submitting deliberate cheats in their name. Every verdict instead
  // stores its evidence in cheat_reason (the run also keeps its ip_hash and
  // input streams) so an admin can assess the user and ban manually from
  // the dashboard.
  const disqualify = async (reason: string, score: number | null) => {
    await client
      .from("runs")
      .update({
        status: "cheated",
        cheat_reason: reason,
        score,
        flap_frames: flaps,
        ...(shots.length ? { shot_frames: shots } : {}),
        ...(revives.length ? { revive_frames: revives } : {}),
        submitted_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    // The verdict's evidence lives in cheat_reason for the admin dashboard
    // ONLY. The response must never say which check tripped or its numbers:
    // specific messages are a tuning oracle — the 2026-08-22 bot operator
    // iterated their noise model against exactly these strings.
    return NextResponse.json(
      { error: "Run rejected.", rejected: true },
      { status: 422 }
    );
  };

  // day must not be finalized (run started before midnight but the board
  // already closed → too late)
  const { data: closed } = await client
    .from("hall_of_fame")
    .select("date")
    .eq("date", run.day)
    .maybeSingle();
  if (closed) return reject("that day's board already closed");

  // Crowning waits for human review, so the hall row can appear hours after
  // midnight — the calendar cutoff must not wait with it. Runs have no time
  // limit anymore, so "longest possible run" can't bound this window; give
  // marathon runs that straddle midnight a generous fixed grace instead,
  // after which the board is frozen even though the champion isn't crowned
  // yet. (The real-time check below still forces a late submit to have
  // genuinely been airborne since before midnight.)
  const dayEndMs = Date.parse(run.day) + 24 * 60 * 60 * 1000;
  const graceMs = 6 * 60 * 60 * 1000;
  if (Date.now() > dayEndMs + graceMs) {
    return reject("that day's board already closed");
  }

  // authoritative replay + behavioral analysis, on the map frozen at run
  // start — the client never gets to pick which sim verifies it. Rows from
  // on databases predating it (or its default) are classic.
  const runMap = isMapId(run.map) ? MAPS[run.map] : MAPS.classic;
  const result = analyzeRun(Number(run.seed), flaps, shots, runMap, revives);
  // generic on purpose: "the replay didn't reproduce your death" would tell
  // a bot author their synthesized inputs diverged from the server sim
  if (!result.died) return reject("Run rejected.");

  // Revive economy check. A run may only claim as many revives as it actually
  // paid for (revives_used, charged atomically at /api/run/revive), and every
  // claimed reviveFrame must land on a real death in the replay
  // (result.revivesUsed counts the ones that did). Either mismatch means a
  // client tried to manufacture free continuations.
  const paidRevives = run.revives_used ?? 0;
  if (revives.length > 0 && run.revives_used === undefined) {
    // client claims revives but the economy isn't migrated in here — can't
    // verify payment, so it can't stand
    return reject("Run rejected.");
  }
  if (revives.length !== paidRevives || result.revivesUsed !== revives.length) {
    return disqualify("revive frames don't match the run's paid revives", result.score);
  }

  // real-time check: a legit run takes at least its sim duration in wall
  // clock (both timestamps are server-side, so this can't misfire on clock
  // skew). Synthesizing a flap array and submitting it early is cheating.
  const elapsedSec = (Date.now() - Date.parse(run.started_at)) / 1000;
  const simSec = result.frames / TICK_HZ;
  if (elapsedSec < simSec * 0.85 - 2) {
    return disqualify(
      `submitted faster than real time (${elapsedSec.toFixed(1)}s wall clock` +
        ` for a ${simSec.toFixed(1)}s run)`,
      result.score
    );
  }

  // Live-checkpoint audit (see src/game/checkpoint.ts): the run must have
  // streamed its progress while it was played, and the streams submitted
  // now must reproduce the hashes committed then. Enforced only when the
  // row was created with a nonce — i.e. schema and server both spoke the
  // protocol at run start.
  if (run.cp_nonce) {
    const cps: CheckpointRow[] = Array.isArray(run.checkpoints)
      ? (run.checkpoints as CheckpointRow[])
      : [];
    const expected = Math.min(
      Math.floor(result.frames / CHECKPOINT_EVERY_FRAMES),
      MAX_CHECKPOINTS
    );
    // generous floor — flaky networks drop beats, but a payload pasted in
    // whole at the end has none at all
    if (cps.length < Math.max(0, Math.floor(expected * 0.8) - 2)) {
      return reject(
        "connection dropped mid-run — the run couldn't be verified live"
      );
    }
    const startMs = Date.parse(run.started_at);
    for (const cp of cps) {
      if (cp.f > result.frames) {
        return disqualify(
          "streamed progress past the run's actual end",
          result.score
        );
      }
      // Boundary tolerance: the client hashes a beat BEFORE the tick that
      // consumes an input landing exactly on the beat frame (pending input
      // is read at the top of the NEXT step — see GameModal's loop), so a
      // tap on frame f is in our <=f prefix but can never be in the
      // client's. Accept either prefix; the ambiguity is at most the
      // boundary frame's inputs. Shipped strict on 2026-08-22 and branded
      // honest players cheaters within the hour — do not tighten this
      // without changing the client contract in lockstep.
      if (
        cp.h !== inputsHash(flaps, shots, cp.f) &&
        cp.h !== inputsHash(flaps, shots, cp.f - 1)
      ) {
        return disqualify(
          "submitted inputs don't match the ones streamed mid-run",
          result.score
        );
      }
      // same real-time rule as the whole-run check below, per beat: both
      // timestamps are server-side, so clock skew can't misfire it
      if ((cp.t - startMs) / 1000 < (cp.f / TICK_HZ) * 0.85 - 2) {
        return disqualify(
          "streamed progress ahead of real time",
          result.score
        );
      }
    }
  }

  // client and server run the same bit-deterministic sim, so a claimed score
  // the replay can't reproduce means the payload was tampered with
  if (result.score !== claimedScore) {
    return disqualify(
      `claimed ${claimedScore} but the replay scores ${result.score}`,
      result.score
    );
  }

  // behavioral tells stay log-only (they misfire on real input quirks): the
  // run scores normally, but the verdict is stored on the run for review
  const suspicion = result.cheat;

  // Daily boost (PH vote / X share): applied ON TOP of the replay-verified
  // score, never inside it — runs.score stays the raw sim number so every
  // stored replay verifies bit-exact forever; the board sees the doubled
  // value. Checked at submit against the run's frozen day, so claiming
  // mid-run counts and a run straddling midnight boosts on the day it
  // plays for.
  const boost = await boostFor(client, run.day, ipHash, run.ip_hash);
  const effective = result.score * boost;

  const now = new Date().toISOString();
  const scoredCols = {
    status: "scored",
    score: result.score,
    flap_frames: flaps,
    ...(shots.length ? { shot_frames: shots } : {}),
    ...(revives.length ? { revive_frames: revives } : {}),
    cheat_reason: suspicion,
    submitted_at: now,
  };
  const { error: scoredErr } = await client
    .from("runs")
    .update({ ...scoredCols, boost, effective_score: effective })
    .eq("id", run.id);
  if (scoredErr?.code === "PGRST204") {
    // boost columns missing (older database): score as before
    await client.from("runs").update(scoredCols).eq("id", run.id);
  }

  // Coins are NOT earned by playing — they're bought (see /api/coins/checkout)
  // and spent on revives. Scoring a run only touches the board below.

  // fold into the daily best — best run counts, nothing can lower it
  const { data: existing } = await client
    .from("daily_scores")
    .select("best_score, runs_count")
    .eq("product_id", run.product_id)
    .eq("day", run.day)
    .maybeSingle();

  const isNewBest = !existing || effective > existing.best_score;
  if (!existing) {
    await client.from("daily_scores").insert({
      product_id: run.product_id,
      day: run.day,
      best_score: effective,
      best_at: effective > 0 ? now : null,
      runs_count: 1,
    });
  } else {
    await client
      .from("daily_scores")
      .update({
        runs_count: existing.runs_count + 1,
        ...(isNewBest ? { best_score: effective, best_at: now } : {}),
      })
      .eq("product_id", run.product_id)
      .eq("day", run.day);
  }

  const best = isNewBest ? effective : existing!.best_score;

  // current rank for the toast
  const { count } = await client
    .from("daily_scores")
    .select("product_id", { count: "exact", head: true })
    .eq("day", run.day)
    .gt("best_score", best);
  const rank = (count ?? 0) + 1;

  return NextResponse.json({
    // the board currency: raw score doubled if a daily boost was active
    score: effective,
    rawScore: result.score,
    boost,
    best,
    isNewBest,
    rank,
  });
}
