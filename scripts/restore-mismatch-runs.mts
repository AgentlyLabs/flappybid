// Remediation for the checkpoint boundary-race false positives (2026-08-22):
// the strict beat-hash check disqualified honest runs whenever a tap landed
// exactly on a beat frame (see src/game/checkpoint.ts, "Boundary contract").
// This re-runs the FULL submit-time audit over every run carrying that
// verdict — replay, wall clock, coverage floor, per-beat frame/hash/timing
// with the tolerant boundary — and restores the ones that pass: status back
// to scored, score folded into the day's board.
//
//   npx tsx scripts/restore-mismatch-runs.mts          # dry run, prints verdicts
//   npx tsx scripts/restore-mismatch-runs.mts --apply  # write the restores
//
// Runs whose day already closed (hall_of_fame row exists) are reported but
// left untouched — the champion is crowned, rewriting history helps nobody.

import { readFileSync } from "node:fs";
import { analyzeRun } from "../src/game/detect";
import { MAPS, isMapId } from "../src/game/maps";
import { TICK_HZ } from "../src/game/constants";
import {
  CHECKPOINT_EVERY_FRAMES,
  MAX_CHECKPOINTS,
  inputsHash,
  type CheckpointRow,
} from "../src/game/checkpoint";

const MISMATCH_REASON = "submitted inputs don't match the ones streamed mid-run";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

interface Run {
  id: string;
  product_id: string;
  day: string;
  seed: number;
  map: string | null;
  score: number | null;
  ip_hash: string | null;
  device_id: string | null;
  flap_frames: number[] | null;
  shot_frames: number[] | null;
  checkpoints: CheckpointRow[] | null;
  started_at: string;
  submitted_at: string;
}

const apply = process.argv.includes("--apply");
const runs = (await rest(
  `runs?status=eq.cheated&cheat_reason=eq.${encodeURIComponent(MISMATCH_REASON)}` +
    `&select=id,product_id,day,seed,map,score,ip_hash,device_id,flap_frames,shot_frames,checkpoints,started_at,submitted_at` +
    `&order=submitted_at.asc`
)) as Run[];
console.log(`${runs.length} run(s) carry the mismatch verdict\n`);

let restored = 0;
for (const run of runs) {
  const tag = `${run.day} ${run.id.slice(0, 8)} score=${run.score}`;
  const flaps = run.flap_frames ?? [];
  const shots = run.shot_frames ?? [];
  const cps = Array.isArray(run.checkpoints) ? run.checkpoints : [];
  if (!flaps.length) {
    console.log(`SKIP    ${tag} — no input streams stored`);
    continue;
  }

  // the whole submit-time gauntlet again, boundary-tolerant this time
  const map = isMapId(run.map) ? MAPS[run.map] : MAPS.classic;
  const result = analyzeRun(Number(run.seed), flaps, shots, map);
  const startMs = Date.parse(run.started_at);
  const wallSec = (Date.parse(run.submitted_at) - startMs) / 1000;
  const expected = Math.min(Math.floor(result.frames / CHECKPOINT_EVERY_FRAMES), MAX_CHECKPOINTS);
  let fail: string | null = null;
  if (!result.died) fail = "run never ended";
  else if (wallSec < (result.frames / TICK_HZ) * 0.85 - 2) fail = "faster than real time";
  else if (cps.length < Math.max(0, Math.floor(expected * 0.8) - 2)) fail = "coverage floor";
  for (const cp of fail ? [] : cps) {
    if (cp.f > result.frames) { fail = `beat past run end (f=${cp.f})`; break; }
    if (cp.h !== inputsHash(flaps, shots, cp.f) && cp.h !== inputsHash(flaps, shots, cp.f - 1)) {
      fail = `beat hash truly mismatched (f=${cp.f})`;
      break;
    }
    if ((cp.t - startMs) / 1000 < (cp.f / TICK_HZ) * 0.85 - 2) {
      fail = `beat ahead of real time (f=${cp.f})`;
      break;
    }
  }
  if (fail) {
    console.log(`GUILTY  ${tag} — ${fail}`);
    continue;
  }

  // banned identities stay disqualified — restoring them re-arms a ban evader
  const conds = [
    `product_id.eq.${run.product_id}`,
    ...(run.ip_hash ? [`ip_hash.eq.${run.ip_hash}`] : []),
    ...(run.device_id ? [`device_id.eq.${run.device_id}`] : []),
  ];
  const bans = (await rest(`bans?or=(${conds.join(",")})&select=id&limit=1`)) as unknown[];
  if (bans.length) {
    console.log(`SKIP    ${tag} — entry or device is banned`);
    continue;
  }

  const closed = (await rest(`hall_of_fame?date=eq.${run.day}&select=date`)) as unknown[];
  if (closed.length) {
    console.log(`SKIP    ${tag} — day already closed (innocent, but the board is frozen)`);
    continue;
  }

  const votes = run.ip_hash
    ? ((await rest(`ph_votes?day=eq.${run.day}&ip_hash=eq.${run.ip_hash}&select=ip_hash&limit=1`)) as unknown[])
    : [];
  const boost = votes.length ? 2 : 1;
  const effective = result.score * boost;
  const verdict = `INNOCENT ${tag} → restore as scored (${result.score}×${boost}${result.cheat ? `, log-only tell: ${result.cheat}` : ""})`;
  if (!apply) {
    console.log(`${verdict} [dry run]`);
    restored += 1;
    continue;
  }

  await rest(`runs?id=eq.${run.id}&status=eq.cheated`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "scored",
      cheat_reason: result.cheat,
      boost,
      effective_score: effective,
    }),
  });
  const existing = (await rest(
    `daily_scores?product_id=eq.${run.product_id}&day=eq.${run.day}&select=best_score,runs_count`
  )) as { best_score: number; runs_count: number }[];
  if (!existing.length) {
    await rest(`daily_scores`, {
      method: "POST",
      body: JSON.stringify({
        product_id: run.product_id,
        day: run.day,
        best_score: effective,
        best_at: effective > 0 ? run.submitted_at : null,
        runs_count: 1,
      }),
    });
  } else {
    const isNewBest = effective > existing[0].best_score;
    await rest(`daily_scores?product_id=eq.${run.product_id}&day=eq.${run.day}`, {
      method: "PATCH",
      body: JSON.stringify({
        runs_count: existing[0].runs_count + 1,
        ...(isNewBest ? { best_score: effective, best_at: run.submitted_at } : {}),
      }),
    });
  }
  console.log(verdict);
  restored += 1;
}
console.log(`\n${restored}/${runs.length} innocent${apply ? ", restored" : " (dry run — pass --apply to restore)"}`);
