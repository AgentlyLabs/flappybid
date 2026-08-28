// Behavioral bot detection on top of the authoritative replay.
//
// The replay proves a score is *valid*; these checks decide whether the
// inputs could have come from a human hand. Every rule is a hard tell with
// thresholds far outside human motor variance (tap jitter at 60Hz is ±1–3
// frames at best), so tripping one is grounds for a permanent ban, not a
// review flag. Prefer letting a marginal bot through over banning a human.

import { createSim, gapCenterAt, revive, step, pipeX } from "./sim";
import { MAPS, type MapDef } from "./maps";
import { BIRD_X, PIPE_WIDTH } from "./constants";
import {
  METRONOME_MIN_FLAPS,
  METRONOME_MAX_STDDEV,
  RAILGUN_MIN_PIPES,
  RAILGUN_MAX_STDDEV,
  BURST_MIN_INTERVALS,
  BURST_MAX_INTERVAL,
  BURST_FRACTION,
  QUANTIZED_MIN_FLAPS,
  QUANTIZED_TOP2_FRACTION,
} from "./thresholds";

export interface RunAnalysis {
  score: number;
  frames: number;
  died: boolean;
  flapCount: number;
  /** std dev of frames between consecutive flaps */
  intervalStdDev: number | null;
  /** std dev of the bird's px offset from each gap center as it crosses */
  offsetStdDev: number | null;
  pipesCrossed: number;
  /** how many of the given reviveFrames actually landed on a death */
  revivesUsed: number;
  /** ban reason, or null if the run looks human */
  cheat: string | null;
}

// Every bar below is tuned per deployment through the environment; see
// game/thresholds.ts for the env var names and the loose public defaults.
//
// METRONOME — sub-frame periodicity sustained over N+ taps.
// RAILGUN   — threading N+ gaps on the same line within X px; only a solver
//             that optimizes its trajectory holds a line that tight.
// BURST     — hold-to-climb bots flap on consecutive frames. Isolated
//             adjacent-frame doubles happen (touch + mouse double fire), so
//             this needs a sustained fraction of a long run.
// QUANTIZED — hover bots emit intervals drawn from one or two exact frame
//             counts; human jitter spans 4+ buckets at 16.7ms/frame.

function stdDev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

function top2Fraction(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  return ((sorted[0] ?? 0) + (sorted[1] ?? 0)) / xs.length;
}

/**
 * Authoritative replay plus instrumentation. Same stepping as replay() in
 * sim.ts, but additionally samples the bird's line through every gap.
 */
export function analyzeRun(
  seed: number,
  flapFrames: number[],
  shootFrames: number[] = [],
  map: MapDef = MAPS.classic,
  reviveFrames: number[] = []
): RunAnalysis {
  const state = createSim(seed, map);
  let fi = 0;
  let si = 0;
  let ri = 0;
  const lastFlap = flapFrames.length ? flapFrames[flapFrames.length - 1] : -1;
  const lastRevive = reviveFrames.length
    ? reviveFrames[reviveFrames.length - 1]
    : -1;
  const lastActive = Math.max(lastFlap, lastRevive);
  const offsets: number[] = [];
  let crossed = 0;

  while (!state.dead) {
    const flap = fi < flapFrames.length && flapFrames[fi] === state.frame;
    if (flap) fi += 1;
    const shoot = si < shootFrames.length && shootFrames[si] === state.frame;
    if (shoot) si += 1;
    step(state, flap, shoot);
    // a paid revive, honored only when the sim actually died on this frame —
    // same contract as replay() in sim.ts
    if (state.dead && ri < reviveFrames.length && reviveFrames[ri] === state.frame) {
      revive(state);
      ri += 1;
    }
    // one sample per pipe: the bird's offset from the gap center the moment
    // the pipe's midline scrolls past it (the *swayed* center on moving
    // maps — a solver tracks that line just as tightly)
    while (
      !state.dead &&
      crossed < state.pipes.length &&
      pipeX(state, state.pipes[crossed]) + PIPE_WIDTH / 2 <= BIRD_X
    ) {
      offsets.push(state.birdY - gapCenterAt(state, state.pipes[crossed]));
      crossed += 1;
    }
    // >10s of freefall after the final flap/revive cannot keep the bird alive
    if (!state.dead && state.frame > lastActive + 600) break;
  }

  const intervals = flapFrames.slice(1).map((f, i) => f - flapFrames[i]);
  const intervalStdDev = intervals.length ? stdDev(intervals) : null;
  const offsetStdDev = offsets.length ? stdDev(offsets) : null;

  let cheat: string | null = null;
  if (
    flapFrames.length >= METRONOME_MIN_FLAPS &&
    intervalStdDev !== null &&
    intervalStdDev < METRONOME_MAX_STDDEV
  ) {
    cheat = `machine-perfect flap timing (${flapFrames.length} flaps, ${intervalStdDev.toFixed(2)}-frame jitter)`;
  } else if (
    offsets.length >= RAILGUN_MIN_PIPES &&
    offsetStdDev !== null &&
    offsetStdDev < RAILGUN_MAX_STDDEV
  ) {
    cheat = `machine-perfect gap threading (${offsets.length} pipes, ${offsetStdDev.toFixed(1)}px spread)`;
  } else if (
    intervals.length >= BURST_MIN_INTERVALS &&
    intervals.filter((iv) => iv <= BURST_MAX_INTERVAL).length / intervals.length >=
      BURST_FRACTION
  ) {
    cheat = `superhuman tap rate (${Math.round(
      (intervals.filter((iv) => iv <= BURST_MAX_INTERVAL).length / intervals.length) * 100
    )}% of ${intervals.length} intervals at 30Hz+)`;
  } else if (
    flapFrames.length >= QUANTIZED_MIN_FLAPS &&
    top2Fraction(intervals) >= QUANTIZED_TOP2_FRACTION
  ) {
    cheat = `mechanical flap rhythm (${Math.round(top2Fraction(intervals) * 100)}% of ${intervals.length} intervals on two exact frame counts)`;
  }

  return {
    score: state.score,
    frames: state.frame,
    died: state.dead,
    flapCount: flapFrames.length,
    intervalStdDev,
    offsetStdDev,
    pipesCrossed: crossed,
    revivesUsed: ri,
    cheat,
  };
}
