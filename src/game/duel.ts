// Deterministic duel-arena simulation — OSRS-style bird fights.
//
// Unlike the course sim (sim.ts), a duel happens in a static pit: no
// scrolling, no pipes, no rng at all. Two input scripts — every flap,
// weapon switch, protect toggle and attack, stamped with frame indices —
// fully determine the fight. The client advances this sim live (against a
// practice dummy while recording, against the real opponent's script on
// reveal) and the server replays the exact same merge to pick the winner.
// Same discipline as sim.ts: only IEEE-exact ops (+ - * / min max floor,
// plus sqrt, which IEEE 754 requires to be correctly rounded — unlike
// Math.sin & co., which never belong in here).
//
// Combat model:
//   - three weapons in a triangle: beak blade (melee lunge), feather gun
//     (three-shot burst with travel time), egg mortar (lobbed arc + splash)
//   - one overhead protect at a time blocks 80% of its damage type, but
//     drains a focus meter while held — flick it, don't camp it
//   - spec bar builds from damage dealt/taken; at full it buys one
//     mega-laser: long telegraph, unblockable row sweep
//   - attacks never carry an aim: the sim aims them at the opponent's
//     position when they fire. Recorded blind, the script still fights.
//
// Every constant below feeds the deterministic sim on BOTH sides, so —
// exactly like map physics — they are frozen once anyone has posted a
// duel. Rebalancing is a new DUEL_VERSION.

import {
  WIDTH,
  FLOOR_Y,
  BIRD_RADIUS,
  GRAVITY,
  FLAP_IMPULSE,
  MAX_FALL_SPEED,
  BEAM_HALF_HEIGHT,
} from "./constants";

/** Bump whenever anything below changes fight outcomes. Stamped on every
 *  posted script; a stale client gets a "refresh" instead of a mismatch. */
export const DUEL_VERSION = 1;

// ---------------------------------------------------------------- arena --

export const DUEL_MAX_FRAMES = 5400; // 90s hard cap; timeout → damage wins
export const DUEL_HP = 99;
export const SUDDEN_DEATH_HP = 35;

export const A_START_X = 110;
export const B_START_X = WIDTH - 110;
export const DUEL_START_Y = 280;

/** Projectile cover. Birds fly through these (they're background stone);
 *  feathers break on them and eggs burst on them, so they're cover, not
 *  terrain. One standing column mid-pit plus one floating slab above it. */
export const PILLARS: ReadonlyArray<{
  x: number;
  y: number;
  w: number;
  h: number;
}> = [
  { x: WIDTH / 2 - 16, y: 300, w: 32, h: FLOOR_Y - 300 },
  { x: WIDTH / 2 - 32, y: 150, w: 64, h: 36 },
];

// ------------------------------------------------------------- movement --

// Vertical physics reuse the classic feel; horizontal control comes from
// directional flaps: a flap-left/right is a normal flap plus a sideways
// shove that decays with friction. The floor is sand, not death — a duel
// ends at 0 HP, and a bird standing still is just an easy target.
export const HORIZ_IMPULSE = 3.2;
export const HORIZ_FRICTION = 0.93;

// -------------------------------------------------------------- weapons --

export const WEAPON_COUNT = 3;
export const W_BLADE = 0;
export const W_FEATHER = 1;
export const W_EGG = 2;

export const WEAPON_DMG = [22, 7, 16] as const; // feathers hit per shot
export const WEAPON_CD = [50, 45, 80] as const; // frames between attacks
export const SWITCH_LOCK = 20; // frames you can't attack after switching

export const LUNGE_SPEED = 9;
export const LUNGE_FRAMES = 10;
export const BLADE_RANGE = BIRD_RADIUS * 2 + 6; // center distance that cuts

export const FEATHER_SPEED = 7.5;
export const FEATHER_RADIUS = 3;
export const FEATHER_BURST = 3;
export const FEATHER_GAP = 6; // frames between burst shots

export const EGG_FLIGHT = 55; // frames the lob takes to reach its mark
export const EGG_GRAVITY = 0.32;
export const EGG_RADIUS = 6;
export const EGG_SPLASH = 52; // burst radius that still deals full damage

// ------------------------------------------------------ protects & spec --

export const FOCUS_MAX = 100;
export const PROTECT_DRAIN = 0.4; // per frame held
export const PROTECT_REGEN = 0.25; // per frame off
/** A matching protect keeps only 20% of the damage (floored). */
export const BLOCK_KEEP = 0.2;

export const SPEC_MAX = 100;
export const SPEC_WARN = 24; // telegraph frames before the beam
export const SPEC_FIRE = 6; // lethal frames
export const SPEC_DMG = 40; // unblockable
export const SPEC_HALF_HEIGHT = BEAM_HALF_HEIGHT;
/** spec gained = dealt/2 + taken/4, floored, capped at SPEC_MAX */

// --------------------------------------------------------------- inputs --

// A script is a flat array of [frame, mask] pairs, frames strictly
// increasing, mask a bitwise OR of the actions taken that frame.
export const ACT_FLAP = 1;
export const ACT_LEFT = 2;
export const ACT_RIGHT = 4;
export const ACT_ATTACK = 8;
export const ACT_EQ_BLADE = 16;
export const ACT_EQ_FEATHER = 32;
export const ACT_EQ_EGG = 64;
export const ACT_PROT_OFF = 128;
export const ACT_PROT_BEAK = 256;
export const ACT_PROT_FEATHER = 512;
export const ACT_PROT_EGG = 1024;
export const ACT_SPEC = 2048;
const ACT_ALL = 4095;

/** One pair per active frame keeps scripts small; this cap (with the
 *  frame cap) bounds server replay cost the same way MAX_FLAPS does. */
export const DUEL_MAX_EVENTS = 2700;

export type DuelScript = number[]; // flat [frame, mask, frame, mask, ...]

export interface DuelRuleset {
  bladesOnly: boolean;
  noProtect: boolean;
  noSpec: boolean;
  suddenDeath: boolean;
}

export const DEFAULT_RULESET: DuelRuleset = {
  bladesOnly: false,
  noProtect: false,
  noSpec: false,
  suddenDeath: false,
};

/** Coerce untrusted json into a canonical ruleset (unknown keys dropped). */
export function normalizeRuleset(raw: unknown): DuelRuleset {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    bladesOnly: r.bladesOnly === true,
    noProtect: r.noProtect === true,
    noSpec: r.noSpec === true,
    suddenDeath: r.suddenDeath === true,
  };
}

/** Structural check for an untrusted script. Cheap; run before storing. */
export function validateScript(s: unknown): s is DuelScript {
  if (!Array.isArray(s)) return false;
  if (s.length % 2 !== 0) return false;
  if (s.length > DUEL_MAX_EVENTS * 2) return false;
  let prev = -1;
  for (let i = 0; i < s.length; i += 2) {
    const f = s[i];
    const m = s[i + 1];
    if (!Number.isInteger(f) || !Number.isInteger(m)) return false;
    if (f <= prev || f >= DUEL_MAX_FRAMES) return false;
    if (m <= 0 || m > ACT_ALL) return false;
    prev = f;
  }
  return true;
}

// ---------------------------------------------------------------- state --

export interface Fighter {
  x: number;
  y: number;
  velX: number;
  velY: number;
  hp: number;
  weapon: number; // W_BLADE | W_FEATHER | W_EGG
  attackCd: number; // frames until the next attack
  switchLock: number; // frames until a switch stops blocking attacks
  protect: number; // 0 off, 1 beak, 2 feathers, 3 eggs
  focus: number;
  spec: number;
  /** frame the spec was cast, and the row it locked; -9999 = never */
  specCast: number;
  specY: number;
  specHit: boolean; // this cast already connected
  lungeLeft: number; // frames left in the committed dash
  lungeVx: number;
  lungeVy: number;
  lungeHit: boolean; // this lunge already connected
  burstLeft: number; // feathers still to spawn this burst
  burstNext: number; // frame the next burst feather spawns
  dmgDealt: number;
}

export interface DuelProjectile {
  kind: number; // W_FEATHER | W_EGG
  owner: number; // fighter index
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** A landed (or blocked) hit, kept for the renderer's splats. Part of the
 *  deterministic state, but never feeds back into the fight. */
export interface DuelHit {
  frame: number;
  target: number;
  dmg: number;
  blocked: boolean;
  kind: number; // weapon index, or 3 for spec
}

export interface DuelState {
  frame: number;
  fighters: [Fighter, Fighter];
  projectiles: DuelProjectile[];
  hits: DuelHit[];
  over: boolean;
  /** 0 = fighter A, 1 = fighter B, 2 = draw; -1 while running */
  winner: number;
  ruleset: DuelRuleset;
}

function makeFighter(x: number, hp: number): Fighter {
  return {
    x,
    y: DUEL_START_Y,
    velX: 0,
    velY: 0,
    hp,
    weapon: W_BLADE,
    attackCd: 0,
    switchLock: 0,
    protect: 0,
    focus: FOCUS_MAX,
    spec: 0,
    specCast: -9999,
    specY: 0,
    specHit: false,
    lungeLeft: 0,
    lungeVx: 0,
    lungeVy: 0,
    lungeHit: false,
    burstLeft: 0,
    burstNext: 0,
    dmgDealt: 0,
  };
}

export function createDuel(ruleset: DuelRuleset = DEFAULT_RULESET): DuelState {
  const hp = ruleset.suddenDeath ? SUDDEN_DEATH_HP : DUEL_HP;
  return {
    frame: 0,
    fighters: [makeFighter(A_START_X, hp), makeFighter(B_START_X, hp)],
    projectiles: [],
    hits: [],
    over: false,
    winner: -1,
    ruleset,
  };
}

// ----------------------------------------------------------------- step --

/** Damage after the target's protect, floored to an integer. Spec (kind 3)
 *  ignores protects entirely. Returns [damage, blocked]. */
function applyProtect(
  target: Fighter,
  kind: number,
  base: number
): [number, boolean] {
  if (kind !== 3 && target.protect === kind + 1) {
    return [Math.floor(base * BLOCK_KEEP), true];
  }
  return [base, false];
}

function insidePillar(x: number, y: number, r: number): boolean {
  for (const p of PILLARS) {
    const nx = Math.max(p.x, Math.min(x, p.x + p.w));
    const ny = Math.max(p.y, Math.min(y, p.y + p.h));
    const dx = x - nx;
    const dy = y - ny;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/**
 * Advance one 60Hz frame with each fighter's action mask for this frame.
 * All aiming reads the frame-start snapshot so neither side gains an order
 * advantage; damage lands after both fighters act, so mutual KOs happen.
 * Mutates and returns the state. No-op once over.
 */
export function stepDuel(
  state: DuelState,
  maskA: number,
  maskB: number
): DuelState {
  if (state.over) return state;
  const rules = state.ruleset;
  const [fa, fb] = state.fighters;
  const snap = [
    { x: fa.x, y: fa.y },
    { x: fb.x, y: fb.y },
  ];
  const masks = [maskA, maskB];
  const pending: [number, number] = [0, 0]; // damage, applied at frame end

  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const opp = snap[1 - i];
    const mask = masks[i];

    if (f.attackCd > 0) f.attackCd -= 1;
    if (f.switchLock > 0) f.switchLock -= 1;

    // -- weapon switches (locked out mid-lunge; committed is committed)
    if (f.lungeLeft === 0 && !rules.bladesOnly) {
      const eq = mask & (ACT_EQ_BLADE | ACT_EQ_FEATHER | ACT_EQ_EGG);
      let next = -1;
      if (eq === ACT_EQ_BLADE) next = W_BLADE;
      else if (eq === ACT_EQ_FEATHER) next = W_FEATHER;
      else if (eq === ACT_EQ_EGG) next = W_EGG;
      // several equip bits at once is a garbled input — ignore it
      if (next !== -1 && next !== f.weapon) {
        f.weapon = next;
        f.switchLock = SWITCH_LOCK;
      }
    }

    // -- protect toggles (exclusive bits; garbled combinations ignored)
    if (!rules.noProtect) {
      const pr =
        mask & (ACT_PROT_OFF | ACT_PROT_BEAK | ACT_PROT_FEATHER | ACT_PROT_EGG);
      if (pr === ACT_PROT_OFF) f.protect = 0;
      else if (pr === ACT_PROT_BEAK) f.protect = 1;
      else if (pr === ACT_PROT_FEATHER) f.protect = 2;
      else if (pr === ACT_PROT_EGG) f.protect = 3;
    }
    if (f.protect !== 0) {
      f.focus = Math.max(0, f.focus - PROTECT_DRAIN);
      if (f.focus === 0) f.protect = 0; // burnt out — re-toggle after regen
    } else {
      f.focus = Math.min(FOCUS_MAX, f.focus + PROTECT_REGEN);
    }

    // -- spec: full bar buys one telegraphed row sweep, hit or miss
    if (
      mask & ACT_SPEC &&
      !rules.noSpec &&
      f.spec >= SPEC_MAX &&
      state.frame >= f.specCast + SPEC_WARN + SPEC_FIRE
    ) {
      f.spec = 0;
      f.specCast = state.frame;
      f.specY = f.y; // the row locks at cast — dodge the telegraph
      f.specHit = false;
    }

    // -- attack with the equipped weapon
    if (
      mask & ACT_ATTACK &&
      f.attackCd === 0 &&
      f.switchLock === 0 &&
      f.lungeLeft === 0
    ) {
      f.attackCd = WEAPON_CD[f.weapon];
      if (f.weapon === W_BLADE) {
        // commit to a dash at where they are right now
        let dx = opp.x - f.x;
        let dy = opp.y - f.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0) {
          dx = i === 0 ? 1 : -1;
          dy = 0;
        } else {
          dx /= d;
          dy /= d;
        }
        f.lungeLeft = LUNGE_FRAMES;
        f.lungeVx = dx * LUNGE_SPEED;
        f.lungeVy = dy * LUNGE_SPEED;
        f.lungeHit = false;
      } else if (f.weapon === W_FEATHER) {
        f.burstLeft = FEATHER_BURST;
        f.burstNext = state.frame; // first feather leaves this frame
      } else {
        // lob an egg that lands on their current spot in EGG_FLIGHT frames
        const dx = opp.x - f.x;
        const dy = opp.y - f.y;
        state.projectiles.push({
          kind: W_EGG,
          owner: i,
          x: f.x,
          y: f.y,
          vx: dx / EGG_FLIGHT,
          vy: dy / EGG_FLIGHT - (EGG_GRAVITY * EGG_FLIGHT) / 2,
        });
      }
    }

    // -- burst feathers keep leaving after the trigger pull, re-aimed at
    //    the opponent's fresh position each time
    if (f.burstLeft > 0 && state.frame >= f.burstNext) {
      let dx = opp.x - f.x;
      let dy = opp.y - f.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) {
        dx = i === 0 ? 1 : -1;
        dy = 0;
      } else {
        dx /= d;
        dy /= d;
      }
      state.projectiles.push({
        kind: W_FEATHER,
        owner: i,
        x: f.x,
        y: f.y,
        vx: dx * FEATHER_SPEED,
        vy: dy * FEATHER_SPEED,
      });
      f.burstLeft -= 1;
      f.burstNext = state.frame + FEATHER_GAP;
    }

    // -- movement
    if (f.lungeLeft > 0) {
      // committed: the dash owns the bird until it's done
      f.velX = f.lungeVx;
      f.velY = f.lungeVy;
      f.lungeLeft -= 1;
      if (f.lungeLeft === 0) {
        f.velX = f.lungeVx * 0.4;
        f.velY = 0;
      }
    } else {
      const left = (mask & ACT_LEFT) !== 0;
      const right = (mask & ACT_RIGHT) !== 0;
      // a directional flap is a flap: the sideways shove rides an up-impulse
      const flap = (mask & ACT_FLAP) !== 0 || left !== right;
      if (left && !right) f.velX = -HORIZ_IMPULSE;
      else if (right && !left) f.velX = HORIZ_IMPULSE;
      if (flap) {
        f.velY = FLAP_IMPULSE;
      } else {
        f.velY = Math.min(f.velY + GRAVITY, MAX_FALL_SPEED);
      }
      f.velX *= HORIZ_FRICTION;
      if (f.velX < 0.05 && f.velX > -0.05) f.velX = 0;
    }
    f.x += f.velX;
    f.y += f.velY;

    // pit bounds: walls and ceiling shrug, the sand floor is solid ground
    if (f.x < BIRD_RADIUS) {
      f.x = BIRD_RADIUS;
      f.velX = 0;
    }
    if (f.x > WIDTH - BIRD_RADIUS) {
      f.x = WIDTH - BIRD_RADIUS;
      f.velX = 0;
    }
    if (f.y < BIRD_RADIUS) {
      f.y = BIRD_RADIUS;
      f.velY = 0;
    }
    if (f.y > FLOOR_Y - BIRD_RADIUS) {
      f.y = FLOOR_Y - BIRD_RADIUS;
      f.velY = 0;
    }
  }

  // -- projectiles fly, break on cover, land on birds
  const alive: DuelProjectile[] = [];
  for (const p of state.projectiles) {
    if (p.kind === W_EGG) p.vy += EGG_GRAVITY;
    p.x += p.vx;
    p.y += p.vy;
    const r = p.kind === W_EGG ? EGG_RADIUS : FEATHER_RADIUS;
    const target = state.fighters[1 - p.owner];
    const tdx = target.x - p.x;
    const tdy = target.y - p.y;
    const touchR = BIRD_RADIUS + r;
    const touching = tdx * tdx + tdy * tdy < touchR * touchR;

    if (p.kind === W_FEATHER) {
      if (touching) {
        const [dmg, blocked] = applyProtect(target, W_FEATHER, WEAPON_DMG[W_FEATHER]);
        pending[1 - p.owner] += dmg;
        state.fighters[p.owner].dmgDealt += dmg;
        state.hits.push({
          frame: state.frame,
          target: 1 - p.owner,
          dmg,
          blocked,
          kind: W_FEATHER,
        });
        continue;
      }
      if (
        p.x < -r ||
        p.x > WIDTH + r ||
        p.y < -r ||
        p.y > FLOOR_Y ||
        insidePillar(p.x, p.y, r)
      ) {
        continue; // broke on a wall, the sand, or cover
      }
    } else {
      // eggs burst on contact, cover, or the sand — splash checks follow
      const burst =
        touching || p.y > FLOOR_Y - r || insidePillar(p.x, p.y, r);
      if (burst) {
        const sr = EGG_SPLASH + BIRD_RADIUS;
        if (touching || tdx * tdx + tdy * tdy < sr * sr) {
          const [dmg, blocked] = applyProtect(target, W_EGG, WEAPON_DMG[W_EGG]);
          pending[1 - p.owner] += dmg;
          state.fighters[p.owner].dmgDealt += dmg;
          state.hits.push({
            frame: state.frame,
            target: 1 - p.owner,
            dmg,
            blocked,
            kind: W_EGG,
          });
        }
        continue;
      }
      if (p.x < -r || p.x > WIDTH + r || p.y < -r) continue;
    }
    alive.push(p);
  }
  state.projectiles = alive;

  // -- blades and beams land against post-move positions
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const target = state.fighters[1 - i];

    if (f.lungeLeft > 0 && !f.lungeHit) {
      const dx = target.x - f.x;
      const dy = target.y - f.y;
      if (dx * dx + dy * dy < BLADE_RANGE * BLADE_RANGE) {
        f.lungeHit = true;
        const [dmg, blocked] = applyProtect(target, W_BLADE, WEAPON_DMG[W_BLADE]);
        pending[1 - i] += dmg;
        f.dmgDealt += dmg;
        state.hits.push({
          frame: state.frame,
          target: 1 - i,
          dmg,
          blocked,
          kind: W_BLADE,
        });
      }
    }

    const sincecast = state.frame - f.specCast;
    if (
      !f.specHit &&
      sincecast >= SPEC_WARN &&
      sincecast < SPEC_WARN + SPEC_FIRE
    ) {
      const dy = target.y - f.specY;
      const reach = SPEC_HALF_HEIGHT + BIRD_RADIUS;
      if (dy >= -reach && dy <= reach) {
        f.specHit = true;
        pending[1 - i] += SPEC_DMG; // unblockable
        f.dmgDealt += SPEC_DMG;
        state.hits.push({
          frame: state.frame,
          target: 1 - i,
          dmg: SPEC_DMG,
          blocked: false,
          kind: 3,
        });
      }
    }
  }

  // -- damage lands simultaneously (mutual KOs are real), and the spec
  //    bar charges off both directions: half of dealt, a quarter of taken
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    f.hp = Math.max(0, f.hp - pending[i]);
    f.spec = Math.min(
      SPEC_MAX,
      f.spec + Math.floor(pending[1 - i] / 2) + Math.floor(pending[i] / 4)
    );
  }

  state.frame += 1;

  const koA = state.fighters[0].hp === 0;
  const koB = state.fighters[1].hp === 0;
  if (koA || koB || state.frame >= DUEL_MAX_FRAMES) {
    state.over = true;
    if (koA && !koB) state.winner = 1;
    else if (koB && !koA) state.winner = 0;
    else if (koA && koB) state.winner = 2;
    else {
      // timeout: damage decides, dead-even is a draw
      const da = state.fighters[0].dmgDealt;
      const db = state.fighters[1].dmgDealt;
      state.winner = da > db ? 0 : db > da ? 1 : 2;
    }
  }

  return state;
}

// --------------------------------------------------------------- replay --

export interface DuelResult {
  winner: number; // 0 A, 1 B, 2 draw
  frames: number;
  hp: [number, number];
  dmg: [number, number];
  koWin: boolean; // false = timeout decision / draw
}

/**
 * Authoritative merge of two scripts. Both sides run this: the client to
 * show the fight, the server to decide it. Scripts must already pass
 * validateScript.
 */
export function duelReplay(
  scriptA: DuelScript,
  scriptB: DuelScript,
  ruleset: DuelRuleset = DEFAULT_RULESET
): DuelResult {
  const state = createDuel(ruleset);
  let ai = 0;
  let bi = 0;
  while (!state.over) {
    let maskA = 0;
    let maskB = 0;
    if (ai < scriptA.length && scriptA[ai] === state.frame) {
      maskA = scriptA[ai + 1];
      ai += 2;
    }
    if (bi < scriptB.length && scriptB[bi] === state.frame) {
      maskB = scriptB[bi + 1];
      bi += 2;
    }
    stepDuel(state, maskA, maskB);
  }
  return {
    winner: state.winner,
    frames: state.frame,
    hp: [state.fighters[0].hp, state.fighters[1].hp],
    dmg: [state.fighters[0].dmgDealt, state.fighters[1].dmgDealt],
    koWin: state.fighters[0].hp === 0 || state.fighters[1].hp === 0,
  };
}

// ---------------------------------------------------------------- dummy --

/**
 * The practice dummy's script: what you spar against while recording your
 * own. Closed-form (no rng) so every recording session sees the identical
 * dummy — hover-flaps with a drift cycle, weapons rotating every ~7s,
 * protects rotating off-phase, attacks on a steady beat.
 */
export function dummyScript(): DuelScript {
  const s: DuelScript = [];
  for (let f = 0; f < DUEL_MAX_FRAMES; f++) {
    let mask = 0;
    if (f % 26 === 0) {
      const drift = Math.floor(f / 26) % 6;
      mask |= drift === 2 ? ACT_LEFT : drift === 5 ? ACT_RIGHT : ACT_FLAP;
    }
    if (f % 420 === 60) {
      const w = Math.floor(f / 420) % 3;
      mask |= w === 0 ? ACT_EQ_BLADE : w === 1 ? ACT_EQ_FEATHER : ACT_EQ_EGG;
    }
    if (f % 90 === 30) mask |= ACT_ATTACK;
    if (f % 350 === 100) {
      const p = Math.floor(f / 350) % 4;
      mask |=
        p === 0
          ? ACT_PROT_BEAK
          : p === 1
            ? ACT_PROT_FEATHER
            : p === 2
              ? ACT_PROT_EGG
              : ACT_PROT_OFF;
    }
    if (f % 600 === 599) mask |= ACT_SPEC; // fires whenever the bar is full
    if (mask !== 0) s.push(f, mask);
  }
  return s;
}

// ------------------------------------------------------------- sparring --

/**
 * The practice-round bot: a reactive policy for client-side sparring, so a
 * test fight feels like a duel rather than shadow-boxing the dummy. Pure
 * function of the state (no rng, no clock) — a practice fight replays
 * exactly from the two recorded scripts. Never used in scored fights:
 * real opponents are always blind recordings.
 */
export function practiceBot(state: DuelState, me: number): number {
  const f = state.fighters[me];
  const o = state.fighters[1 - me];
  const fr = state.frame;
  let mask = 0;

  // rotate the arsenal every ~7s so every protect gets tested
  if (fr > 0 && fr % 420 === 0) {
    const w = Math.floor(fr / 420) % 3;
    mask |= w === 0 ? ACT_EQ_FEATHER : w === 1 ? ACT_EQ_EGG : ACT_EQ_BLADE;
  }

  // movement: chase with the blade, keep range with the projectiles,
  // and stay roughly on the opponent's line so shots trade both ways
  const climb = f.y > o.y - 8;
  if (fr % 4 === 0) {
    if (f.weapon === W_BLADE) {
      mask |= o.x > f.x ? ACT_RIGHT : ACT_LEFT;
    } else {
      const dx = o.x - f.x;
      if (dx * dx < 190 * 190) mask |= o.x > f.x ? ACT_LEFT : ACT_RIGHT;
      else if (climb) mask |= ACT_FLAP;
    }
  } else if (fr % 4 === 2 && climb && f.velY > 2) {
    mask |= ACT_FLAP;
  }

  // attack on cooldown — the blade only commits in lunge range
  if (f.attackCd === 0 && f.switchLock === 0 && fr % 3 === 0) {
    if (f.weapon === W_BLADE) {
      const dx = o.x - f.x;
      const dy = o.y - f.y;
      if (dx * dx + dy * dy < 150 * 150) mask |= ACT_ATTACK;
    } else {
      mask |= ACT_ATTACK;
    }
  }

  // protect flicks toward whatever they're holding, dropped between
  // beats to save focus — the habit the tutorial wants to teach
  if (fr % 70 === 10) {
    mask |=
      o.weapon === W_BLADE
        ? ACT_PROT_BEAK
        : o.weapon === W_FEATHER
          ? ACT_PROT_FEATHER
          : ACT_PROT_EGG;
  }
  if (fr % 70 === 55) mask |= ACT_PROT_OFF;

  if (f.spec >= SPEC_MAX && fr % 7 === 0) mask |= ACT_SPEC;
  return mask;
}

