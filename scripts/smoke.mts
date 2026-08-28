// End-to-end smoke test against a running dev server + live Supabase.
//   npx tsx scripts/smoke.mts [baseUrl]
// Plays a real (scripted) run, waits out the real-time check, submits, and
// verifies the tamper path gets rejected.

import { createSim, step, pipeX } from "../src/game/sim.ts";
import { BIRD_X, PIPE_WIDTH } from "../src/game/constants.ts";

// The 30-minute frame ceiling was removed from the sim (payload caps in
// MAX_FLAPS/MAX_SHOTS bound a run instead); these harnesses still need a
// runaway guard, so they carry their own — the same bound the server-side
// replay in lib/suspicion.ts uses.
const MAX_RUN_FRAMES = 400_000;

const BASE = process.argv[2] ?? "http://localhost:3457";

function playBot(seed: number) {
  const sim = createSim(seed);
  const flaps: number[] = [];
  while (!sim.dead && sim.frame < MAX_RUN_FRAMES) {
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
  return { score: sim.score, flaps, frames: sim.frame };
}

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

let failed = 0;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
}

// 1. enter a product
const enter = await post("/api/enter", { input: "agently.dev" });
check("enter product", enter.status === 200 && !!enter.data.product?.id);
const productId = enter.data.product.id;

// 2. honest run
const start = await post("/api/run/start", { productId });
check("start run", start.status === 200 && !!start.data.runId);
const bot = playBot(start.data.seed);
console.log(`      bot flew score=${bot.score} frames=${bot.frames}`);
const waitSec = Math.max(0, (bot.frames / 60) * 0.85 - 2 + 1.5);
console.log(`      waiting ${waitSec.toFixed(1)}s to satisfy real-time check`);
await new Promise((r) => setTimeout(r, waitSec * 1000));
const submit = await post("/api/run/submit", {
  runId: start.data.runId,
  flapFrames: bot.flaps,
  claimedScore: bot.score,
});
check(
  "honest submit accepted",
  submit.status === 200 && submit.data.score === bot.score,
  JSON.stringify(submit.data)
);

// 3. tampered claim (inflated score) must be rejected
const start2 = await post("/api/run/start", { productId });
const bot2 = playBot(start2.data.seed);
await new Promise((r) => setTimeout(r, 3000));
const cheat = await post("/api/run/submit", {
  runId: start2.data.runId,
  flapFrames: bot2.flaps,
  claimedScore: bot2.score + 50,
});
check("inflated claim rejected", cheat.status === 422, JSON.stringify(cheat.data));

// 4. instant replay-bot submit (no wall-clock wait) must be rejected
const start3 = await post("/api/run/start", { productId });
const bot3 = playBot(start3.data.seed);
const instant = await post("/api/run/submit", {
  runId: start3.data.runId,
  flapFrames: bot3.flaps,
  claimedScore: bot3.score,
});
// short runs legitimately pass (tolerance); only assert when the run was long
if (bot3.frames / 60 > 10) {
  check("instant submit rejected", instant.status === 422, JSON.stringify(instant.data));
} else {
  console.log(`      (run too short to exercise real-time check: ${bot3.frames} frames)`);
}

// 5. leaderboard shows the product
const board = await fetch(BASE + "/api/leaderboard").then((r) => r.json());
const entry = board.entries.find((e: { id: string }) => e.id === productId);
check(
  "on the leaderboard",
  !!entry && entry.score >= bot.score,
  entry ? `rank #${entry.rank} score ${entry.score}` : "not found"
);

console.log(failed ? `\n${failed} FAILURE(S)` : "\nall good");
process.exit(failed ? 1 : 0);
