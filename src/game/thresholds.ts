// Detector tuning, read from the environment.
//
// Server-only: nothing here is imported from a "use client" module, so the
// values never reach the browser bundle. That is the point — a solver author
// who can read the exact bar can sit just outside it, so the numbers a
// deployment actually runs on live in its env, not in this file.
//
// The defaults below are deliberately LOOSE: they catch blatant automation
// and little else, which is the right failure mode for a fresh clone (a
// missed bot is cheap, a banned human is not). Tighten them per deployment
// via the env vars named alongside each one.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── ban-grade (game/detect.ts) ──────────────────────────────────────────
// Sub-half-frame periodicity sustained over N taps.
export const METRONOME_MIN_FLAPS = num("DETECT_METRONOME_MIN_FLAPS", 25);
export const METRONOME_MAX_STDDEV = num("DETECT_METRONOME_MAX_STDDEV", 0.35);

// Threading N+ gaps on the same line within X px.
export const RAILGUN_MIN_PIPES = num("DETECT_RAILGUN_MIN_PIPES", 12);
export const RAILGUN_MAX_STDDEV = num("DETECT_RAILGUN_MAX_STDDEV", 1.0);

// Hold-to-climb bots flapping on consecutive frames.
export const BURST_MIN_INTERVALS = num("DETECT_BURST_MIN_INTERVALS", 30);
export const BURST_MAX_INTERVAL = num("DETECT_BURST_MAX_INTERVAL", 2);
export const BURST_FRACTION = num("DETECT_BURST_FRACTION", 0.4);

// Hover bots emitting intervals drawn from one or two exact frame counts.
export const QUANTIZED_MIN_FLAPS = num("DETECT_QUANTIZED_MIN_FLAPS", 40);
export const QUANTIZED_TOP2_FRACTION = num("DETECT_QUANTIZED_TOP2_FRACTION", 0.95);

// ── advisory chips (lib/suspicion.ts) ───────────────────────────────────
// A crossing closer than this to the gap edge counts as a near-death.
export const CLOSE_CALL_PX = num("SUSPICION_CLOSE_CALL_PX", 15);

export const S_MECHANICAL_MIN_FLAPS = num("SUSPICION_MECHANICAL_MIN_FLAPS", 25);
export const S_MECHANICAL_MAX_JITTER = num("SUSPICION_MECHANICAL_MAX_JITTER", 1.5);

export const S_SUBHUMAN_MIN_FLAPS = num("SUSPICION_SUBHUMAN_MIN_FLAPS", 1000);
export const S_SUBHUMAN_MAX_JITTER = num("SUSPICION_SUBHUMAN_MAX_JITTER", 7);

export const S_RAILGUN_MIN_PIPES = num("SUSPICION_RAILGUN_MIN_PIPES", 12);
export const S_RAILGUN_MAX_SPREAD = num("SUSPICION_RAILGUN_MAX_SPREAD", 4);

export const S_RAZOR_MIN_PIPES = num("SUSPICION_RAZOR_MIN_PIPES", 500);
export const S_RAZOR_MIN_RATIO = num("SUSPICION_RAZOR_MIN_RATIO", 0.12);

export const S_SAFETY_FLOOR_MIN_PIPES = num("SUSPICION_SAFETY_FLOOR_MIN_PIPES", 1000);

export const S_NODOUBLE_MIN_INTERVALS = num("SUSPICION_NODOUBLE_MIN_INTERVALS", 500);
export const S_NODOUBLE_MIN_GAP = num("SUSPICION_NODOUBLE_MIN_GAP", 10);

export const S_BURST_MIN_INTERVALS = num("SUSPICION_BURST_MIN_INTERVALS", 30);
export const S_BURST_MAX_INTERVAL = num("SUSPICION_BURST_MAX_INTERVAL", 2);
export const S_BURST_FRACTION = num("SUSPICION_BURST_FRACTION", 0.2);

export const S_FATIGUE_MIN_INTERVALS = num("SUSPICION_FATIGUE_MIN_INTERVALS", 90);
export const S_FATIGUE_MAX_RATIO = num("SUSPICION_FATIGUE_MAX_RATIO", 1.05);

export const S_ACE_MAX_RUNS = num("SUSPICION_ACE_MAX_RUNS", 3);
export const S_ACE_WARN_SCORE = num("SUSPICION_ACE_WARN_SCORE", 100);
export const S_ACE_HIGH_SCORE = num("SUSPICION_ACE_HIGH_SCORE", 150);

export const S_CLIFF_MIN_RUNS = num("SUSPICION_CLIFF_MIN_RUNS", 20);
export const S_CLIFF_MULTIPLE = num("SUSPICION_CLIFF_MULTIPLE", 15);

export const S_WARMUP_MIN_RUNS = num("SUSPICION_WARMUP_MIN_RUNS", 8);
export const S_WARMUP_MAX_LOW_TAIL = num("SUSPICION_WARMUP_MAX_LOW_TAIL", 0.15);

export const S_FLAT_MAX_CV = num("SUSPICION_FLAT_MAX_CV", 0.2);

export const S_CHURN_MIN_DEVICES = num("SUSPICION_CHURN_MIN_DEVICES", 6);
export const S_CHURN_MIN_RATIO = num("SUSPICION_CHURN_MIN_RATIO", 0.5);

export const S_RESTART_MIN_GAPS = num("SUSPICION_RESTART_MIN_GAPS", 6);
export const S_RESTART_MAX_STDDEV_MS = num("SUSPICION_RESTART_MAX_STDDEV_MS", 1500);

export const S_GRIND_MIN_RUNS = num("SUSPICION_GRIND_MIN_RUNS", 150);
export const S_NOBREAK_MIN_HOURS = num("SUSPICION_NOBREAK_MIN_HOURS", 3);
