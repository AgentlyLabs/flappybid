import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeRun } from "@/game/detect";
import { MAPS, isMapId, type MapDef } from "@/game/maps";
import { createSim, gapCenterAt, step, pipeX } from "@/game/sim";
import {
  CLOSE_CALL_PX,
  S_MECHANICAL_MIN_FLAPS, S_MECHANICAL_MAX_JITTER,
  S_SUBHUMAN_MIN_FLAPS, S_SUBHUMAN_MAX_JITTER,
  S_RAILGUN_MIN_PIPES, S_RAILGUN_MAX_SPREAD,
  S_RAZOR_MIN_PIPES, S_RAZOR_MIN_RATIO,
  S_SAFETY_FLOOR_MIN_PIPES,
  S_NODOUBLE_MIN_INTERVALS, S_NODOUBLE_MIN_GAP,
  S_BURST_MIN_INTERVALS, S_BURST_MAX_INTERVAL, S_BURST_FRACTION,
  S_FATIGUE_MIN_INTERVALS, S_FATIGUE_MAX_RATIO,
  S_ACE_MAX_RUNS, S_ACE_WARN_SCORE, S_ACE_HIGH_SCORE,
  S_CLIFF_MIN_RUNS, S_CLIFF_MULTIPLE,
  S_WARMUP_MIN_RUNS, S_WARMUP_MAX_LOW_TAIL,
  S_FLAT_MAX_CV,
  S_CHURN_MIN_DEVICES, S_CHURN_MIN_RATIO,
  S_RESTART_MIN_GAPS, S_RESTART_MAX_STDDEV_MS,
  S_GRIND_MIN_RUNS, S_NOBREAK_MIN_HOURS,
} from "@/game/thresholds";
import { BIRD_X, PIPE_WIDTH, BIRD_RADIUS } from "@/game/constants";

// Cross-run bot profiling for the admin dashboard. Where game/detect.ts
// judges one run against hard, ban-grade thresholds, this looks at an
// entry's whole day and surfaces the softer statistical tells a review
// human should weigh: faking one realistic run is easy, faking a human
// *career* — warmup deaths, fatigue, ragged restart timing — is hard.
// Everything here is advisory; nothing auto-bans.

export interface SuspicionTag {
  /** short chip text */
  label: string;
  /** the reason, in plain words */
  detail: string;
  /** high = probably a bot; warn = statistically odd, worth a close watch */
  severity: "high" | "warn";
}

interface RunRow {
  score: number | null;
  started_at: string;
  submitted_at: string | null;
  cheat_reason: string | null;
  device_id?: string | null;
}

function stdDev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

// Replay the run once more, sampling how close the bird passed to the gap
// edge at every pipe. Tap-timing statistics can be mimicked from published
// thresholds; flight-path risk is harder to fake in either direction — real
// players graze death constantly (one flagged pair never did across 3,700
// pipes: cosmetic wobble on a planned-safe path), while a line-optimizer
// shaves the edge on every fifth gap (one flagged solver: 20% vs humans'
// <1%).
function pathRisk(
  seed: number,
  flaps: number[],
  shots: number[],
  map: MapDef
): { pipes: number; closeCalls: number } {
  const state = createSim(seed, map);
  let fi = 0;
  let si = 0;
  let crossed = 0;
  let closeCalls = 0;
  const halfGap = map.pipeGap / 2;
  const lastFlap = flaps.length ? flaps[flaps.length - 1] : -1;
  while (!state.dead && state.frame < 400_000) {
    const flap = fi < flaps.length && flaps[fi] === state.frame;
    if (flap) fi += 1;
    const shoot = si < shots.length && shots[si] === state.frame;
    if (shoot) si += 1;
    step(state, flap, shoot);
    if (crossed < state.pipes.length) {
      const p = state.pipes[crossed];
      if (pipeX(state, p) + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
        const clearance =
          halfGap - Math.abs(state.birdY - gapCenterAt(state, p));
        if (clearance < CLOSE_CALL_PX) closeCalls += 1;
        crossed += 1;
      }
    }
    if (fi >= flaps.length && state.frame > lastFlap + 600) break;
  }
  return { pipes: crossed, closeCalls };
}

export async function suspicionTags(
  client: SupabaseClient,
  productId: string,
  day: string
): Promise<SuspicionTag[]> {
  // The run that matters for the board, and the device that flew it.
  const first = await client
    .from("runs")
    .select("seed, flap_frames, shot_frames, ip_hash, map, device_id")
    .eq("product_id", productId)
    .eq("day", day)
    .eq("status", "scored")
    .not("flap_frames", "is", null)
    .order("score", { ascending: false })
    .limit(1)
    .maybeSingle();
  let bestRun:
    | (NonNullable<(typeof first)["data"]> & { device_id?: string | null })
    | null = first.data;
  if (first.error) {
    // runs.device_id missing (older database)
    ({ data: bestRun } = await client
      .from("runs")
      .select("seed, flap_frames, shot_frames, ip_hash, map")
      .eq("product_id", productId)
      .eq("day", day)
      .eq("status", "scored")
      .not("flap_frames", "is", null)
      .order("score", { ascending: false })
      .limit(1)
      .maybeSingle());
  }

  // Both identities the best run carries: the salted IP hash and the device
  // cookie. A career is anything matching either — rotating proxies no
  // longer mints a clean slate as long as the cookie survives.
  const deviceConds = [
    bestRun?.ip_hash ? `ip_hash.eq.${bestRun.ip_hash}` : null,
    bestRun?.device_id ? `device_id.eq.${bestRun.device_id}` : null,
  ].filter(Boolean) as string[];

  // Career stats profile ONLY that device's runs. Product ids are public and
  // anyone can submit runs "for" any entry (see lib/ban.ts), so a drive-by
  // cheater must not be able to paint detector tells — and through them a
  // "high" ban confidence — onto an entry they don't own. Unattributable
  // runs (null ip_hash, pre-forensics) drop out for the same reason.
  let runQuery = client
    .from("runs")
    .select("score, started_at, submitted_at, cheat_reason, device_id")
    .eq("product_id", productId)
    .eq("day", day)
    .in("status", ["scored", "cheated"])
    .order("started_at", { ascending: true })
    .limit(1000);
  if (deviceConds.length) runQuery = runQuery.or(deviceConds.join(","));
  const { data } = await runQuery;
  const runs = (data ?? []) as RunRow[];
  const tags: SuspicionTag[] = [];
  if (!runs.length) return tags;

  // ── detector verdicts — the per-run analyzer already called it, on the
  // driving device's own runs
  const tells = runs.filter((r) => r.cheat_reason);
  if (tells.length) {
    tags.push({
      severity: "high",
      label: `detector tells ×${tells.length}`,
      detail: tells[tells.length - 1].cheat_reason!,
    });
  }

  // ── the driving device's rap sheet: hard cheat verdicts (fabricated
  // payloads, early submits) on ANY entry, any day. An operator that got
  // caught tampering once and now tops the board is the strongest tell we
  // have — noise-injected solvers beat every per-run statistic, but they
  // can't scrub their device's history.
  if (deviceConds.length) {
    const { count } = await client
      .from("runs")
      .select("id", { count: "exact", head: true })
      .or(deviceConds.join(","))
      .eq("status", "cheated");
    if ((count ?? 0) > 0) {
      tags.push({
        severity: "high",
        label: `device cheat history ×${count}`,
        detail: `the device behind the best run has ${count} hard cheat verdict${count === 1 ? "" : "s"} (fabricated or early-submitted runs) on record`,
      });
    }
    // the same device tripping log-only behavioral tells on OTHER entries is
    // an operator making their rounds (one device planted a board score for
    // one entry and ran its solver raw on another the same hour). Warn-only
    // — a double-firing input device also leaves tells.
    const { count: tellsElsewhere } = await client
      .from("runs")
      .select("id", { count: "exact", head: true })
      .or(deviceConds.join(","))
      .eq("status", "scored")
      .not("cheat_reason", "is", null)
      .neq("product_id", productId);
    if ((tellsElsewhere ?? 0) > 0) {
      tags.push({
        severity: "warn",
        label: `device tells elsewhere ×${tellsElsewhere}`,
        detail: `the best run's device has ${tellsElsewhere} behavioral detector tell${tellsElsewhere === 1 ? "" : "s"} on other entries' runs — an operator touring the board, or a double-firing input device`,
      });
    }
  }
  if (bestRun?.flap_frames) {
    const flaps = bestRun.flap_frames as number[];
    const a = analyzeRun(
      Number(bestRun.seed),
      flaps,
      (bestRun.shot_frames as number[] | null) ?? [],
      isMapId(bestRun.map) ? MAPS[bestRun.map] : MAPS.classic
    );
    if (
      a.flapCount >= S_MECHANICAL_MIN_FLAPS &&
      a.intervalStdDev !== null &&
      a.intervalStdDev < S_MECHANICAL_MAX_JITTER
    ) {
      tags.push({
        severity: "high",
        label: "near-mechanical timing",
        detail: `best run taps with ${a.intervalStdDev.toFixed(2)}-frame jitter; human motor noise is ~2 frames or more`,
      });
    }
    // population-improbable, not physically-impossible: every verified human
    // marathon on 2026-08-22 sat at 9.5+ frames of jitter, every solver
    // generation below it (clamped gen 8.2-8.8, a flagged solver 6.8). The old 1.5
    // old, looser bar only ever caught bots that weren't trying.
    if (
      a.flapCount >= S_SUBHUMAN_MIN_FLAPS &&
      a.intervalStdDev !== null &&
      a.intervalStdDev >= S_MECHANICAL_MAX_JITTER &&
      a.intervalStdDev < S_SUBHUMAN_MAX_JITTER
    ) {
      tags.push({
        severity: "high",
        label: "sub-human jitter",
        detail: `${a.intervalStdDev.toFixed(1)}-frame tap jitter held across ${a.flapCount} flaps; verified human marathons never run tighter than ~9.5`,
      });
    }
    if (
      a.pipesCrossed >= S_RAILGUN_MIN_PIPES &&
      a.offsetStdDev !== null &&
      a.offsetStdDev < S_RAILGUN_MAX_SPREAD
    ) {
      tags.push({
        severity: "high",
        label: "railgun line",
        detail: `holds the gap line within ${a.offsetStdDev.toFixed(1)}px across ${a.pipesCrossed} pipes; humans spread tens of px`,
      });
    }
    // flight-path risk: where the bird crossed each gap, from a second replay
    const risk = pathRisk(
      Number(bestRun.seed),
      flaps,
      (bestRun.shot_frames as number[] | null) ?? [],
      isMapId(bestRun.map) ? MAPS[bestRun.map] : MAPS.classic
    );
    if (
      risk.pipes >= S_RAZOR_MIN_PIPES &&
      risk.closeCalls / risk.pipes >= S_RAZOR_MIN_RATIO
    ) {
      tags.push({
        severity: "high",
        label: "razor line",
        detail: `${risk.closeCalls} of ${risk.pipes} crossings within ${CLOSE_CALL_PX}px of a pipe edge (${Math.round((risk.closeCalls / risk.pipes) * 100)}%) — humans stay under ~1%; a line-optimizer shaves the edge for minutes on end`,
      });
    }
    if (risk.pipes >= S_SAFETY_FLOOR_MIN_PIPES && risk.closeCalls === 0) {
      tags.push({
        severity: "high",
        label: "safety floor",
        detail: `never once within ${CLOSE_CALL_PX}px of a pipe edge across ${risk.pipes} gaps — humans graze death constantly; injected wobble on a planned-safe path never does`,
      });
    }
    const intervals = flaps.slice(1).map((f, i) => f - flaps[i]);
    // clamped noise floor: humans panic-double-tap (every verified human run
    // of 500+ flaps has at least one gap under 10 frames); a generator with
    // a minimum-interval clamp never does. This is the 18-frame fingerprint
    // the 2026-08-22 clamped generation shared across entries.
    if (
      intervals.length >= S_NODOUBLE_MIN_INTERVALS &&
      Math.min(...intervals) >= S_NODOUBLE_MIN_GAP
    ) {
      tags.push({
        severity: "high",
        label: "no double-taps",
        detail: `fastest tap gap is ${Math.min(...intervals)} frames across ${intervals.length + 1} flaps — humans panic-double-tap under pressure; a clamped noise generator can't`,
      });
    }
    if (intervals.length >= S_BURST_MIN_INTERVALS) {
      const burst =
        intervals.filter((iv) => iv <= S_BURST_MAX_INTERVAL).length /
        intervals.length;
      if (burst >= S_BURST_FRACTION) {
        tags.push({
          severity: "high",
          label: "30Hz bursts",
          detail: `${Math.round(burst * 100)}% of best-run intervals are 30Hz+ tapping — double the human record rate`,
        });
      }
      // humans loosen up late in a long run; bots stay stationary
      if (intervals.length >= S_FATIGUE_MIN_INTERVALS) {
        const third = Math.floor(intervals.length / 3);
        const early = stdDev(intervals.slice(0, third));
        const late = stdDev(intervals.slice(-third));
        if (early > 0.5 && late / early < S_FATIGUE_MAX_RATIO) {
          tags.push({
            severity: "warn",
            label: "no fatigue",
            detail: `tap jitter never drifts across a ${intervals.length + 1}-flap run (late/early ×${(late / early).toFixed(2)}); tired hands get sloppier`,
          });
        }
      }
    }
  }

  // ── score distribution: humans leave a trail of warmup deaths
  const scores = runs
    .filter((r) => r.score !== null)
    .map((r) => r.score as number);
  const best = Math.max(...scores, 0);
  // a top score with (almost) no career: the warmup/flat-score checks below
  // need 8+ runs, so a bot that lands one big run and stops was invisible to
  // them — yet "first try, 150+" is itself the loudest career tell there is.
  // Gated on the ENTRY also being thin: relay users (iCloud Private Relay
  // rotates ip_hash mid-session) split one human career across hashes, and
  // each slice reads "brand-new" — but their entry still shows the full
  // warmup trail, so an entry with real history suppresses the chip.
  const { count: entryScored } = await client
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("day", day)
    .eq("status", "scored");
  if (
    scores.length <= S_ACE_MAX_RUNS &&
    (entryScored ?? 0) <= S_ACE_MAX_RUNS &&
    best >= S_ACE_WARN_SCORE
  ) {
    tags.push({
      severity: best >= S_ACE_HIGH_SCORE ? "high" : "warn",
      label: "instant ace",
      detail: `${best} within ${scores.length} run${scores.length === 1 ? "" : "s"} of a brand-new career — humans leave warmup wreckage first`,
    });
  }
  // one monster bracketed by junk: humans build to a peak through 100s and
  // 300s and decay from fatigue after; a solver's career is noise around
  // zero with a single planted outlier (one flagged career: 50 runs under
  // 41, then 1032, then junk again). Warn-only — a genuine breakthrough is possible,
  // but it comes with a visible build-up.
  if (scores.length >= S_CLIFF_MIN_RUNS && best >= S_ACE_WARN_SCORE) {
    const second = Math.max(
      1,
      ...scores.filter((s) => s !== best),
      ...(scores.filter((s) => s === best).length > 1 ? [best] : [])
    );
    if (best >= S_CLIFF_MULTIPLE * second) {
      tags.push({
        severity: "warn",
        label: "career cliff",
        detail: `best ${best} is ${Math.round(best / second)}× the career's second-best (${second}) across ${scores.length} runs — junk-grind bracketing one outlier`,
      });
    }
  }
  if (scores.length >= S_WARMUP_MIN_RUNS && best >= 10) {
    const lowBar = Math.max(2, Math.floor(best * 0.3));
    const lowTail = scores.filter((s) => s <= lowBar).length / scores.length;
    if (lowTail < S_WARMUP_MAX_LOW_TAIL) {
      tags.push({
        severity: "warn",
        label: "no warmup deaths",
        detail: `only ${Math.round(lowTail * 100)}% of ${scores.length} runs died under ${lowBar}; humans crash low constantly`,
      });
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (mean >= 10 && stdDev(scores) / mean < S_FLAT_MAX_CV) {
      tags.push({
        severity: "warn",
        label: "flat scores",
        detail: `${scores.length} runs within ±${Math.round((stdDev(scores) / mean) * 100)}% of a ${Math.round(mean)} average — human skill swings far wider`,
      });
    }
  }

  // ── device-cookie churn: fb_device is a year-long cookie, so one IP's
  // career normally shows one or two device ids. A fresh id on run after
  // run is a wipe-everything bot loop shedding its cookie jar. Warn-only,
  // never high: CGNAT legitimately folds many real devices behind one
  // ip_hash, and this career is IP-linked by construction.
  const deviceIds = new Set(
    runs.map((r) => r.device_id).filter((d): d is string => Boolean(d))
  );
  if (
    deviceIds.size >= S_CHURN_MIN_DEVICES &&
    deviceIds.size / runs.length >= S_CHURN_MIN_RATIO
  ) {
    tags.push({
      severity: "warn",
      label: `device churn ×${deviceIds.size}`,
      detail: `${deviceIds.size} distinct device cookies across ${runs.length} runs from this career — a browser keeps its cookie for a year; a bot loop mints one per run (or a busy shared IP)`,
    });
  }

  // ── restart cadence: death → next run, humans are ragged, scripts exact.
  // Warn-only with a tight bar: a locked-in human who always restarts the
  // instant the death screen lands clusters inside a second or two, so
  // sub-2.5s regularity alone was never ban-grade evidence.
  const gaps: number[] = [];
  for (let i = 1; i < runs.length; i++) {
    if (!runs[i - 1].submitted_at) continue;
    const gap =
      Date.parse(runs[i].started_at) - Date.parse(runs[i - 1].submitted_at!);
    if (gap > 0 && gap < 5 * 60_000) gaps.push(gap);
  }
  if (gaps.length >= S_RESTART_MIN_GAPS && stdDev(gaps) < S_RESTART_MAX_STDDEV_MS) {
    tags.push({
      severity: "warn",
      label: "scripted restarts",
      detail: `${gaps.length + 1} runs restarted with ±${(stdDev(gaps) / 1000).toFixed(1)}s regularity — humans pause, rage, take breaks (or grind with instant restarts, hence warn-only)`,
    });
  }

  // ── volume: sheer grind no human sustains
  if (runs.length >= S_GRIND_MIN_RUNS) {
    tags.push({
      severity: "warn",
      label: "grind volume",
      detail: `${runs.length} finished runs today`,
    });
  }
  let sessionStart = Date.parse(runs[0].started_at);
  let longest = 0;
  for (let i = 1; i < runs.length; i++) {
    const t = Date.parse(runs[i].started_at);
    if (t - Date.parse(runs[i - 1].started_at) > 10 * 60_000) {
      sessionStart = t;
    }
    longest = Math.max(longest, t - sessionStart);
  }
  if (longest >= S_NOBREAK_MIN_HOURS * 3600_000) {
    tags.push({
      severity: "warn",
      label: "no breaks",
      detail: `${(longest / 3600_000).toFixed(1)}h of continuous runs without a 10-minute pause`,
    });
  }

  return tags.slice(0, 5);
}

export type BanConfidence = "high" | "medium" | "low";

// One word the ban button can lean on. Deliberately conservative mapping:
// "high" should mean "we'd defend this ban in public with the evidence
// listed on the chips", not "the vibes are off".
//
// Checkpoint-protocol tampering (mid-run hash mismatch, ahead-of-real-time
// beats) needs no rule of its own: those verdicts land as status=cheated,
// so they surface through the tamper-grade "device cheat history" path
// below.
export function banConfidence(tags: SuspicionTag[]): BanConfidence {
  // Only tamper-grade evidence stands alone: a hard cheat verdict means the
  // device provably fabricated a payload, submitted ahead of real time or
  // broke the checkpoint protocol. Behavioral detector tells do NOT — they
  // are kept log-only at submit precisely because they can misfire on real
  // input quirks (see run/submit), so a lone tell counts as one "high" chip
  // below and needs corroboration to reach high.
  if (tags.some((t) => t.label.startsWith("device cheat history"))) {
    return "high";
  }
  const highs = tags.filter((t) => t.severity === "high").length;
  const warns = tags.length - highs;
  if (highs >= 2 || (highs === 1 && warns >= 1)) return "high";
  if (highs === 1 || warns >= 2) return "medium";
  return "low";
}
