// Determinism check: a scripted "player" flies the live sim, we record its
// flap frames, then replay them the way the server does. Scores must match
// exactly, run after run. Run with:
//   node --experimental-strip-types scripts/test-sim.mts

import { createSim, step, replay, pipeX } from "../src/game/sim.ts";
import { BIRD_X, PIPE_WIDTH } from "../src/game/constants.ts";

// The 30-minute frame ceiling was removed from the sim (payload caps in
// MAX_FLAPS/MAX_SHOTS bound a run instead); these harnesses still need a
// runaway guard, so they carry their own — the same bound the server-side
// replay in lib/suspicion.ts uses.
const MAX_RUN_FRAMES = 400_000;

function playBot(seed: number): { score: number; flaps: number[] } {
  const sim = createSim(seed);
  const flaps: number[] = [];
  while (!sim.dead && sim.frame < MAX_RUN_FRAMES) {
    // aim for the gap center of the next pipe ahead of the bird
    let target = 300;
    for (const pipe of sim.pipes) {
      if (pipeX(sim, pipe) + PIPE_WIDTH >= BIRD_X - 20) {
        target = pipe.gapCenter;
        break;
      }
    }
    const flap = sim.birdY > target && sim.velY >= 0;
    if (flap) flaps.push(sim.frame);
    step(sim, flap);
  }
  return { score: sim.score, flaps };
}

let failures = 0;
for (const seed of [1, 42, 1337, 987654321, 2 ** 31 - 2]) {
  const { score, flaps } = playBot(seed);
  const r1 = replay(seed, flaps);
  const r2 = replay(seed, flaps);
  const ok = r1.score === score && r2.score === score && r1.died;
  if (!ok) failures++;
  console.log(
    `seed=${seed} live=${score} replay=${r1.score}/${r2.score} flaps=${flaps.length} ${ok ? "OK" : "MISMATCH"}`
  );
}

// a tampered claim must not reproduce: drop one flap, score should differ or die earlier
const { score, flaps } = playBot(987654321);
const tampered = replay(987654321, flaps.slice(0, -3));
console.log(
  `tamper check: honest=${score} tampered=${tampered.score} ${tampered.score <= score ? "OK" : "MISMATCH"}`
);
if (tampered.score > score) failures++;

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("determinism verified");
