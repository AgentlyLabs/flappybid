// Arena tick-combat checks: scripted duelists fight live, the intent log
// replays deterministically, options are enforced, fights terminate. Run:
//   npx tsx scripts/test-arena.mts

import {
  createArena,
  stepArena,
  arenaReplay,
  normalizeArenaOptions,
  DEFAULT_ARENA_OPTIONS,
  WEAPONS,
  MAX_TICKS,
  BERRIES,
  type ArenaIntent,
  type ArenaLog,
  type ArenaState,
} from "../src/game/arena.ts";

type Policy = (st: ArenaState, me: number) => ArenaIntent;

/** Rides the whole rack — switches weapons every few ticks. */
const switcher: Policy = (st, me) => {
  const f = st.fighters[me];
  const it: ArenaIntent = { engage: true };
  if (st.tick % 5 === 2) it.weapon = (f.weapon + 1) % WEAPONS.length;
  if (f.specEnergy >= 50) {
    it.weapon = WEAPONS.length - 1; // the big maul spec is the KO tool
    it.spec = true;
  }
  if (f.hp < 35 && f.berries > 0) it.eat = true;
  return it;
};

/** Locks a slow spike weapon and swings, eats late. */
const brawler: Policy = (st, me) => {
  const f = st.fighters[me];
  const it: ArenaIntent = { engage: true, weapon: 4 };
  if (f.hp < 25 && f.berries > 0) it.eat = true;
  if (f.specEnergy >= 50) it.spec = true;
  return it;
};

/** Fast pecks only, never specs. */
const pecker: Policy = (st, me) => {
  const f = st.fighters[me];
  const it: ArenaIntent = { engage: true, weapon: 0 };
  if (f.hp < 40 && f.berries > 0) it.eat = true;
  return it;
};

/** Does nothing at all — never even engages. */
const pacifist: Policy = () => ({});

const FIGHTERS: Array<[string, Policy]> = [
  ["switcher", switcher],
  ["brawler", brawler],
  ["pecker", pecker],
];

function fight(
  seed: number,
  a: Policy,
  b: Policy,
  options = DEFAULT_ARENA_OPTIONS
): { state: ArenaState; log: ArenaLog } {
  const state = createArena(seed, options);
  const log: ArenaLog = [];
  while (!state.over) {
    const ia = a(state, 0);
    const ib = b(state, 1);
    log.push([ia, ib]);
    stepArena(state, ia, ib);
  }
  return { state, log };
}

let failures = 0;
const check = (cond: boolean, label: string) => {
  if (!cond) {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
};
const W = ["A", "B", "draw"];

console.log("== live/replay agreement + matchups ==");
for (const [an, ap] of FIGHTERS) {
  for (const [bn, bp] of FIGHTERS) {
    for (const seed of [7, 1337]) {
      const { state, log } = fight(seed, ap, bp);
      const r1 = arenaReplay(seed, DEFAULT_ARENA_OPTIONS, log);
      const r2 = arenaReplay(seed, DEFAULT_ARENA_OPTIONS, log);
      const same =
        r1.winner === state.winner &&
        r1.ticks === state.tick &&
        r1.hp[0] === state.fighters[0].hp &&
        r1.hp[1] === state.fighters[1].hp &&
        JSON.stringify(r1) === JSON.stringify(r2);
      check(same, `${an} vs ${bn} seed ${seed} replay mismatch`);
      check(state.tick <= MAX_TICKS, `${an} vs ${bn} terminated`);
      if (seed === 7) {
        console.log(
          `  ${an.padEnd(8)} vs ${bn.padEnd(8)} → ${W[r1.winner]}${r1.ko ? " KO" : ""}` +
            ` in ${String(r1.ticks).padStart(3)}t  hp ${r1.hp[0]}/${r1.hp[1]}  dmg ${r1.dmg[0]}/${r1.dmg[1]} ${same ? "OK" : "MISMATCH"}`
        );
      }
    }
  }
}

console.log("== auto-engage: even pacifists fight after the bell ==");
{
  const { state } = fight(42, pacifist, pacifist);
  check(
    state.fighters[0].dmgDealt > 0 && state.fighters[1].dmgDealt > 0,
    "the bell starts the fight for both"
  );
  console.log(`  ${state.tick} ticks, ${W[state.winner]}, dmg ${state.fighters[0].dmgDealt}/${state.fighters[1].dmgDealt}`);
}

console.log("== options enforced ==");
{
  const noFood = normalizeArenaOptions({ noFood: true });
  const { state } = fight(9, switcher, switcher, noFood);
  check(
    state.fighters[0].berries === 0 && state.fighters[1].berries === 0,
    "noFood empties the pouch"
  );
  const noSpec = normalizeArenaOptions({ noSpec: true });
  const { state: st2 } = fight(9, brawler, brawler, noSpec);
  check(
    st2.fighters[0].specEnergy === 100 && st2.fighters[1].specEnergy === 100,
    "noSpec keeps the energy untouched"
  );
  console.log("  noFood / noSpec hold");
}

console.log("== bogus weapon intents are ignored ==");
{
  const junk: Policy = () => ({ engage: true, weapon: 99 });
  const { state } = fight(11, junk, pacifist);
  check(state.fighters[0].weapon === 0, "out-of-range switch dropped");
  const junk2: Policy = () => ({ engage: true, weapon: -1 });
  const { state: st2 } = fight(11, junk2, pacifist);
  check(st2.fighters[0].weapon === 0, "negative switch dropped");
  console.log("  junk switches bounce off");
}

console.log("== auto-eat: birds in KO range bite without being told ==");
{
  // pacifists never send eat intents, yet with food in the ruleset the
  // sim bites a berry once hp sits inside the foe's max hit
  const { state } = fight(23, pacifist, pacifist);
  const eaten =
    BERRIES * 2 -
    state.fighters[0].berries -
    state.fighters[1].berries;
  check(eaten > 0, "auto-eat never fired");
  console.log(`  ${eaten} berries eaten with zero eat intents`);
}

console.log("== the rack holds: banned weapons can't be drawn ==");
{
  // a whip-only pit: the switcher's rotation and the brawler's spike pick
  // both bounce off; everyone fights with slot 0
  const whipOnly = normalizeArenaOptions({ weapons: [0] });
  const { state } = fight(13, switcher, brawler, whipOnly);
  check(
    state.fighters[0].weapon === 0 && state.fighters[1].weapon === 0,
    "whip-only pins both birds to the whip"
  );
  const pair = normalizeArenaOptions({ weapons: [3, 1, 3] });
  check(JSON.stringify(pair.weapons) === "[1,3]", "picks normalize sorted unique");
  const junk = normalizeArenaOptions({ weapons: [99, -1, "x"] });
  check(
    junk.weapons.length === WEAPONS.length,
    "garbled picks mean the full rack"
  );
  const { state: st2 } = fight(13, brawler, pacifist, pair);
  check(
    st2.fighters[0].weapon === 1,
    "banned pick bounced — bird stays on the rack's first slot"
  );
  console.log("  whip-only and dds+gmaul rulesets hold");
}

console.log("== tamper: a forged log can't keep the verdict ==");
{
  const { state, log } = fight(1337, switcher, brawler);
  const bent: ArenaLog = log.map(([a, b], i) =>
    // strip A's weapon switches (the switcher's whole game) from midgame on
    i > 5 ? [{ ...a, weapon: undefined }, b] : [a, b]
  );
  const clean = arenaReplay(1337, DEFAULT_ARENA_OPTIONS, log);
  const dirty = arenaReplay(1337, DEFAULT_ARENA_OPTIONS, bent);
  check(clean.winner === state.winner, "clean replay matches live");
  const differs =
    dirty.hp[0] !== clean.hp[0] ||
    dirty.hp[1] !== clean.hp[1] ||
    dirty.ticks !== clean.ticks;
  check(differs, "stripped switches diverge the fight");
  console.log(
    `  clean hp ${clean.hp[0]}/${clean.hp[1]} vs forged hp ${dirty.hp[0]}/${dirty.hp[1]}`
  );
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
