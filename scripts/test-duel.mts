// Duel engine checks: scripted fighters play the live merged sim (the way
// two clients would), we record their action masks, then replay the scripts
// the way the server does. Outcomes must match exactly, run after run —
// plus termination, validation, and a balance smoke matrix. Run with:
//   node --experimental-strip-types scripts/test-duel.mts

import {
  createDuel,
  stepDuel,
  duelReplay,
  validateScript,
  dummyScript,
  practiceBot,
  DEFAULT_RULESET,
  normalizeRuleset,
  DUEL_MAX_FRAMES,
  DUEL_MAX_EVENTS,
  ACT_FLAP,
  ACT_LEFT,
  ACT_RIGHT,
  ACT_ATTACK,
  ACT_EQ_BLADE,
  ACT_EQ_FEATHER,
  ACT_EQ_EGG,
  ACT_PROT_BEAK,
  ACT_PROT_FEATHER,
  ACT_PROT_EGG,
  ACT_PROT_OFF,
  ACT_SPEC,
  W_BLADE,
  W_FEATHER,
  W_EGG,
  type DuelState,
  type DuelScript,
  type DuelRuleset,
} from "../src/game/duel.ts";

type Policy = (state: DuelState, me: number) => number;

// -- fighters ---------------------------------------------------------------

/** Rush in, blade out, protect against whatever they're holding. */
const brawler: Policy = (s, i) => {
  const f = s.fighters[i];
  const o = s.fighters[1 - i];
  let mask = 0;
  const above = f.y > o.y - 10; // we're below their line → climb
  if (s.frame % 3 === 0 && above) {
    mask |= o.x > f.x ? ACT_RIGHT : ACT_LEFT;
  }
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  if (dx * dx + dy * dy < 140 * 140) mask |= ACT_ATTACK;
  if (s.frame % 40 === 7) {
    mask |=
      o.weapon === W_BLADE
        ? ACT_PROT_BEAK
        : o.weapon === W_FEATHER
          ? ACT_PROT_FEATHER
          : ACT_PROT_EGG;
  }
  if (f.spec >= 100 && s.frame % 5 === 0) mask |= ACT_SPEC;
  return mask;
};

/** Keep range, feather bursts, drop protect to save focus between volleys. */
const kiter: Policy = (s, i) => {
  const f = s.fighters[i];
  const o = s.fighters[1 - i];
  let mask = 0;
  if (s.frame === 0) mask |= ACT_EQ_FEATHER;
  const away = o.x > f.x ? ACT_LEFT : ACT_RIGHT;
  if (s.frame % 4 === 0) {
    const dx = o.x - f.x;
    mask |= dx * dx < 200 * 200 ? away : f.y > 200 ? ACT_FLAP : 0;
  }
  if (f.weapon === W_FEATHER && f.attackCd === 0) mask |= ACT_ATTACK;
  if (s.frame % 90 === 20) mask |= ACT_PROT_BEAK;
  if (s.frame % 90 === 65) mask |= ACT_PROT_OFF;
  if (f.spec >= 100) mask |= ACT_SPEC;
  return mask;
};

/** Sit high, rain eggs, hold feather protect. */
const mortar: Policy = (s, i) => {
  const f = s.fighters[i];
  let mask = 0;
  if (s.frame === 0) mask |= ACT_EQ_EGG;
  if (s.frame % 14 === 0 && f.y > 130) mask |= ACT_FLAP;
  if (f.weapon === W_EGG && f.attackCd === 0) mask |= ACT_ATTACK;
  if (s.frame % 200 === 10) mask |= ACT_PROT_FEATHER;
  if (f.spec >= 100) mask |= ACT_SPEC;
  return mask;
};

/** Weapon-cycling all-rounder to shake out switch/lock edge cases. */
const cycler: Policy = (s, i) => {
  const f = s.fighters[i];
  const o = s.fighters[1 - i];
  let mask = 0;
  if (s.frame % 300 === 0) {
    const w = Math.floor(s.frame / 300) % 3;
    mask |= w === 0 ? ACT_EQ_FEATHER : w === 1 ? ACT_EQ_EGG : ACT_EQ_BLADE;
  }
  if (s.frame % 5 === 0 && f.y > o.y - 30) mask |= o.x > f.x ? ACT_RIGHT : ACT_LEFT;
  if (f.attackCd === 0 && f.switchLock === 0) mask |= ACT_ATTACK;
  if (s.frame % 70 === 35) mask |= ACT_PROT_EGG;
  if (f.spec >= 100) mask |= ACT_SPEC;
  return mask;
};

const FIGHTERS: Array<[string, Policy]> = [
  ["brawler", brawler],
  ["kiter", kiter],
  ["mortar", mortar],
  ["cycler", cycler],
  // the practice-round bot ships to players; its recorded fights must
  // replay bit-exact or the REMATCH/REWATCH buttons lie
  ["spar-bot", practiceBot],
];

// -- live play → scripts ----------------------------------------------------

function playLive(
  a: Policy,
  b: Policy,
  ruleset: DuelRuleset = DEFAULT_RULESET
): { state: DuelState; scriptA: DuelScript; scriptB: DuelScript } {
  const state = createDuel(ruleset);
  const scriptA: DuelScript = [];
  const scriptB: DuelScript = [];
  while (!state.over) {
    const ma = a(state, 0);
    const mb = b(state, 1);
    if (ma !== 0) scriptA.push(state.frame, ma);
    if (mb !== 0) scriptB.push(state.frame, mb);
    stepDuel(state, ma, mb);
  }
  return { state, scriptA, scriptB };
}

const W = ["A", "B", "draw"];
let failures = 0;

function check(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

// -- 1. live vs replay vs replay, full matrix -------------------------------

console.log("== live/replay agreement + balance matrix ==");
for (const [an, ap] of FIGHTERS) {
  for (const [bn, bp] of FIGHTERS) {
    const { state, scriptA, scriptB } = playLive(ap, bp);
    check(validateScript(scriptA), `${an} script valid`);
    check(validateScript(scriptB), `${bn} script valid`);
    check(
      scriptA.length / 2 <= DUEL_MAX_EVENTS,
      `${an} under event cap (${scriptA.length / 2})`
    );
    const r1 = duelReplay(scriptA, scriptB);
    const r2 = duelReplay(scriptA, scriptB);
    const live = {
      winner: state.winner,
      frames: state.frame,
      hp: [state.fighters[0].hp, state.fighters[1].hp],
      dmg: [state.fighters[0].dmgDealt, state.fighters[1].dmgDealt],
    };
    const same =
      r1.winner === live.winner &&
      r1.frames === live.frames &&
      r1.hp[0] === live.hp[0] &&
      r1.hp[1] === live.hp[1] &&
      r1.dmg[0] === live.dmg[0] &&
      r1.dmg[1] === live.dmg[1] &&
      JSON.stringify(r1) === JSON.stringify(r2);
    check(same, `${an} vs ${bn} live/replay mismatch`);
    check(state.frame <= DUEL_MAX_FRAMES, `${an} vs ${bn} terminated`);
    console.log(
      `  ${an.padEnd(8)} vs ${bn.padEnd(8)} → ${W[r1.winner]}${r1.koWin ? " KO" : ""}` +
        ` in ${String(r1.frames).padStart(4)}f  hp ${r1.hp[0]}/${r1.hp[1]}` +
        `  dmg ${r1.dmg[0]}/${r1.dmg[1]}  ${same ? "OK" : "MISMATCH"}`
    );
  }
}

// -- 2. dummy script sanity -------------------------------------------------

console.log("== dummy ==");
const dummy = dummyScript();
check(validateScript(dummy), "dummy script valid");
const dvsd = duelReplay(dummy, dummy);
check(dvsd.winner === 2, `dummy mirror is a draw (got ${W[dvsd.winner]})`);
console.log(
  `  dummy vs dummy → ${W[dvsd.winner]} in ${dvsd.frames}f dmg ${dvsd.dmg[0]}/${dvsd.dmg[1]}`
);

// -- 3. rulesets ------------------------------------------------------------

console.log("== rulesets ==");
{
  const sd = playLive(brawler, kiter, normalizeRuleset({ suddenDeath: true }));
  const r = duelReplay(sd.scriptA, sd.scriptB, normalizeRuleset({ suddenDeath: true }));
  check(r.winner === sd.state.winner, "sudden death live/replay");
  console.log(`  sudden death: ${W[r.winner]} in ${r.frames}f`);

  // wrong ruleset must not reproduce the same fight silently
  const wrong = duelReplay(sd.scriptA, sd.scriptB, DEFAULT_RULESET);
  console.log(
    `  same scripts, default rules: ${W[wrong.winner]} in ${wrong.frames}f (divergence expected)`
  );

  const bl = playLive(cycler, mortar, normalizeRuleset({ bladesOnly: true }));
  const rbl = duelReplay(bl.scriptA, bl.scriptB, normalizeRuleset({ bladesOnly: true }));
  check(rbl.winner === bl.state.winner, "blades-only live/replay");
  check(
    bl.state.fighters[0].weapon === W_BLADE && bl.state.fighters[1].weapon === W_BLADE,
    "blades-only pins the weapon"
  );
  console.log(`  blades only: ${W[rbl.winner]} in ${rbl.frames}f`);
}

// -- 4. protect actually blocks --------------------------------------------

console.log("== protect ==");
{
  // A feathers nonstop; B holds feather protect and never attacks
  const shooter: Policy = (s, i) => {
    let m = 0;
    if (s.frame === 0) m |= ACT_EQ_FEATHER;
    if (s.frame % 20 === 0) m |= ACT_FLAP;
    if (s.fighters[i].attackCd === 0 && s.fighters[i].weapon === W_FEATHER)
      m |= ACT_ATTACK;
    return m;
  };
  const turtle: Policy = (s) => {
    let m = 0;
    if (s.frame === 0) m |= ACT_PROT_FEATHER;
    if (s.frame % 20 === 10) m |= ACT_FLAP;
    if (s.frame % 100 === 50) m |= ACT_PROT_FEATHER; // re-raise after burnout
    return m;
  };
  const open = playLive(shooter, (s) => (s.frame % 20 === 10 ? ACT_FLAP : 0));
  const guarded = playLive(shooter, turtle);
  const openDmg = open.state.fighters[0].dmgDealt;
  const guardedDmg = guarded.state.fighters[0].dmgDealt;
  check(guardedDmg < openDmg, `protect reduces damage (${guardedDmg} < ${openDmg})`);
  console.log(`  feathers vs open ${openDmg} dmg, vs protect ${guardedDmg} dmg`);
}

// -- 5. tampering diverges --------------------------------------------------

console.log("== tamper ==");
{
  const { scriptA, scriptB } = playLive(brawler, kiter);
  const clean = duelReplay(scriptA, scriptB);
  const bent = scriptA.slice();
  // strip half a second of movement mid-fight — position drift cascades
  // into every auto-aimed shot after it (a single dropped flap can land
  // inside a lunge, where movement input is ignored by design)
  const MOVE = ACT_FLAP | ACT_LEFT | ACT_RIGHT;
  let stripped = 0;
  for (let i = Math.floor(bent.length / 4) * 2; i < bent.length && stripped < 15; i += 2) {
    if (bent[i + 1] & MOVE) {
      bent[i + 1] &= ~MOVE;
      stripped += 1;
      if (bent[i + 1] === 0) {
        bent.splice(i, 2);
        i -= 2;
      }
    }
  }
  const dirty = duelReplay(bent, scriptB);
  const differs =
    dirty.dmg[0] !== clean.dmg[0] ||
    dirty.dmg[1] !== clean.dmg[1] ||
    dirty.frames !== clean.frames ||
    dirty.winner !== clean.winner;
  check(differs, "tampered movement diverges the fight");
  console.log(
    `  dropped one flap: dmg ${clean.dmg[0]}/${clean.dmg[1]} → ${dirty.dmg[0]}/${dirty.dmg[1]}, ` +
      `${W[clean.winner]}→${W[dirty.winner]} in ${clean.frames}→${dirty.frames}f`
  );
}

// -- 6. validation rejects garbage -----------------------------------------

console.log("== validation ==");
check(!validateScript([0]), "odd length rejected");
check(!validateScript([5, 1, 5, 1]), "non-increasing frames rejected");
check(!validateScript([0, 0]), "zero mask rejected");
check(!validateScript([0, 4096]), "out-of-range mask rejected");
check(!validateScript([DUEL_MAX_FRAMES, 1]), "frame past cap rejected");
check(!validateScript([1.5, 1]), "fractional frame rejected");
check(validateScript([0, 1, 10, 2048]), "well-formed script accepted");

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
