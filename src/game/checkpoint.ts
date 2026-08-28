// Live-checkpoint contract, shared by the client (GameModal) and the server
// (/api/run/checkpoint + /api/run/submit) — like the sim constants, any
// drift between the two sides breaks verification.
//
// Every ~10s of sim time the client posts the current frame and a hash of
// every input it has sent SO FAR, echoing a server nonce from the previous
// response. At submit, the final input streams must reproduce those
// mid-run hashes and the checkpoints must have arrived on a real-time
// clock. What this buys: a payload can no longer be pasted in whole at the
// end of a wall-clock wait — producing a run means holding a live,
// sequenced session for its entire duration. (A solver that precomputes
// its inputs and streams them on schedule still passes; this layer exists
// to kill one-shot payload bots and force the rest into the open, where
// the rate limits, Turnstile and behavioral tells operate.)

export const CHECKPOINT_EVERY_FRAMES = 600; // 10s of sim at 60Hz
// bounds jsonb growth; MAX_FLAPS already caps a run at ~12h of sim, which
// is ~4300 checkpoints, so this cap should never bind before the flap cap
export const MAX_CHECKPOINTS = 5_000;

// FNV-1a over the input prefixes — deterministic, dependency-free,
// identical in browser and Node. It doesn't need to be cryptographic: the
// server stores what the client committed mid-run, and the submitted
// streams must reproduce it.
//
// Boundary contract: an input landing exactly ON a beat frame is undecided
// — the client hashes the beat before the tick that would consume it, so
// its prefix ends at f-1 while the server's replay knows the input at f.
// Submit therefore accepts the hash of EITHER prefix (upTo f or f-1);
// verify-side code must never require the inclusive one alone.
export function inputsHash(
  flaps: number[],
  shots: number[],
  upToFrame: number
): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const f of flaps) {
    if (f > upToFrame) break;
    mix(f);
  }
  mix(0xffffffff); // stream separator: flap/shot boundaries can't alias
  for (const f of shots) {
    if (f > upToFrame) break;
    mix(f);
  }
  return h.toString(16).padStart(8, "0");
}

export interface CheckpointRow {
  /** sim frame the client had reached */
  f: number;
  /** inputsHash of everything sent up to that frame */
  h: string;
  /** server-side ms timestamp when the checkpoint landed */
  t: number;
}
