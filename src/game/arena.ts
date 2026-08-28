// The live arena: OSRS-style no-movement duels on a 600ms tick.
//
// Two birds stand beak to beak. After a 3-second count, each player CLICKS
// the opponent to engage; from then on their bird swings automatically at
// its weapon's speed while the human does the real work — switching
// weapons mid-fight, eating between hits, timing the spec. Movement was
// deliberately cut: spacing is the easiest edge for a script to play
// perfectly, so the game keeps only the dimensions where humans compete.
// The pit is purely melee for now — protects, pre-fight gear picks and
// the range/mage sides of the triangle stepped out together and can walk
// back in together.
//
// The server owns this sim (see src/server/hub.ts): clients send intents,
// the server steps one tick every TICK_MS and broadcasts the result. Both
// sides also share a seeded rng + full intent log, so any finished fight
// re-simulates deterministically for audit (arenaReplay) — the same
// replay-verification contract as everything else on the site.

import { mulberry32 } from "./rng";

/** Bump on any change to fight behavior or the wire protocol. */
export const ARENA_VERSION = 11;

/** Coin stakes ceiling for a wagered pit — a hard clamp on the wire; 0 means a
 *  friendly (no-stakes) fight. Coins are ~50 per dollar, so this caps a single
 *  pot's exposure well below anything a wallet realistically holds. */
export const MAX_WAGER = 100_000;

export const TICK_MS = 600;
export const COUNTDOWN_TICKS = 5; // the 3-second stare-down
export const MAX_TICKS = 150; // 90s, then damage decides
export const ARENA_HP = 99;
export const BERRIES = 3;
export const BERRY_HEAL = 22;
export const EAT_ATTACK_DELAY = 2; // ticks your next swing slips when eating
export const SPEC_COST = 50; // two specs per fight, no regen
export const SPEC_ACC_BONUS = 0.15;

// The armory — all melee, switched freely mid-fight (1–6). The classics,
// bird edition. Every stat on the badge is REAL — but the numbers are
// balanced so expected damage per tick is the same for every weapon
// (acc × max/2 ÷ speed ≈ 2.13 across the whole rack). You're choosing a
// damage DISTRIBUTION — fast light pecks vs slow heavy spikes — never an
// average. A stake stays a fair coin; your weapon is which way your
// variance leans. Specs double a swing's max, so slow spike weapons spec
// harder — that's the burst tradeoff, priced into their slower base.
/** `short` is the hotbar face — one readable word, not an OSRS jargon key */
export const WEAPONS = [
  { key: "whip", label: "abyssal wormwhip", short: "wormwhip", bonus: "15 · 3t", speed: 3, max: 15, acc: 0.85 },
  { key: "dds", label: "dragon beak", short: "beak", bonus: "14 · 3t · 91%", speed: 3, max: 14, acc: 0.91 },
  { key: "scim", label: "dragon wing-scim", short: "wing-scim", bonus: "20 · 4t", speed: 4, max: 20, acc: 0.85 },
  { key: "gmaul", label: "granite maul", short: "granite", bonus: "25 · 5t", speed: 5, max: 25, acc: 0.85 },
  { key: "ags", label: "arma godsword", short: "godsword", bonus: "30 · 6t", speed: 6, max: 30, acc: 0.85 },
  { key: "elder", label: "elder eggmaul", short: "eggmaul", bonus: "32 · 6t · 80%", speed: 6, max: 32, acc: 0.8 },
] as const;

export interface ArenaOptions {
  noFood: boolean;
  noSpec: boolean;
  /** the rack for this fight: allowed WEAPONS indices, sorted unique,
   *  never empty — a whip-only duel is `[0]`, everything is 0..5 */
  weapons: number[];
  /** coins each side stakes — winner takes 2×; 0 is a friendly fight. The sim
   *  ignores this (it never touches createArena/stepArena); the hub escrows it
   *  at the bell and settles it at the verdict. */
  wager: number;
}

const fullRack = () => WEAPONS.map((_, i) => i);

export const DEFAULT_ARENA_OPTIONS: ArenaOptions = {
  noFood: false,
  noSpec: false,
  weapons: fullRack(),
  wager: 0,
};

export function normalizeArenaOptions(raw: unknown): ArenaOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const picks = Array.isArray(r.weapons)
    ? [
        ...new Set(
          r.weapons
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 0 && n < WEAPONS.length)
        ),
      ].sort((a, b) => a - b)
    : [];
  const rawWager = Math.floor(Number(r.wager));
  return {
    noFood: r.noFood === true,
    noSpec: r.noSpec === true,
    // an empty (or garbled) pick list means the whole rack, not no rack
    weapons: picks.length ? picks : fullRack(),
    // clamp to a sane, whole, non-negative stake; garbage reads as friendly
    wager: Number.isFinite(rawWager)
      ? Math.min(Math.max(rawWager, 0), MAX_WAGER)
      : 0,
  };
}

/** One player's inputs for a tick. Every field optional; the server keeps
 *  the latest value per field per tick (last click wins). */
export interface ArenaIntent {
  /** clicked the opponent — start (or resume) swinging */
  engage?: boolean;
  /** switch to WEAPONS[i] */
  weapon?: number;
  eat?: boolean;
  /** arm the spec: the next swing spends SPEC_COST for a boosted hit */
  spec?: boolean;
}

export interface ArenaFighter {
  hp: number;
  weapon: number;
  engaged: boolean;
  nextSwing: number; // tick the next attack lands
  specArmed: boolean;
  specEnergy: number;
  berries: number;
  dmgDealt: number;
}

/** What actually happened on a tick, for rendering and the audit log. */
export interface ArenaEvent {
  tick: number;
  actor: number;
  kind: "hit" | "miss" | "eat" | "spec-hit" | "spec-miss" | "ko";
  value: number; // damage dealt / heal amount
}

export interface ArenaState {
  tick: number; // combat ticks (countdown lives in the hub)
  fighters: [ArenaFighter, ArenaFighter];
  events: ArenaEvent[]; // this tick's happenings (cleared per step)
  over: boolean;
  winner: number; // 0, 1, or 2 = draw; -1 while running
  options: ArenaOptions;
  rng: () => number;
}

function makeFighter(options: ArenaOptions): ArenaFighter {
  return {
    hp: ARENA_HP,
    weapon: options.weapons[0] ?? 0,
    engaged: true, // the bell engages both — clicking is ceremony
    nextSwing: 0,
    specArmed: false,
    specEnergy: 100,
    berries: options.noFood ? 0 : BERRIES,
    dmgDealt: 0,
  };
}

export function createArena(
  seed: number,
  options: ArenaOptions = DEFAULT_ARENA_OPTIONS
): ArenaState {
  return {
    tick: 0,
    fighters: [makeFighter(options), makeFighter(options)],
    events: [],
    over: false,
    winner: -1,
    options,
    rng: mulberry32(seed),
  };
}

/**
 * Advance one combat tick with both players' intents. Attacks resolve
 * simultaneously (mutual KO = draw), and the rng draw order is fixed —
 * fighter 0's swing rolls first — so replays agree exactly.
 */
export function stepArena(
  state: ArenaState,
  a: ArenaIntent,
  b: ArenaIntent
): ArenaState {
  if (state.over) return state;
  const opts = state.options;
  const intents = [a, b];
  state.events = [];

  // -- apply instant intents (both sides, before any swings land)
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const it = intents[i];
    if (it.engage) f.engaged = true;
    if (
      it.weapon !== undefined &&
      Number.isInteger(it.weapon) &&
      opts.weapons.includes(it.weapon) &&
      it.weapon !== f.weapon
    ) {
      f.weapon = it.weapon;
      // a fresh weapon swings no sooner than its own speed would allow —
      // rapid switch-mashing can't machine-gun the fast weapon
      const speed = WEAPONS[f.weapon].speed;
      if (f.nextSwing - state.tick > speed) f.nextSwing = state.tick + speed;
    }
    if (it.spec && !opts.noSpec && f.specEnergy >= SPEC_COST) {
      f.specArmed = true;
    }
    if (it.eat && f.berries > 0 && f.hp < ARENA_HP) {
      f.berries -= 1;
      f.hp = Math.min(ARENA_HP, f.hp + BERRY_HEAL);
      f.nextSwing = Math.max(f.nextSwing, state.tick) + EAT_ATTACK_DELAY;
      state.events.push({
        tick: state.tick,
        actor: i,
        kind: "eat",
        value: BERRY_HEAL,
      });
    }
  }

  // -- auto-eat: with food in the ruleset, a bird sitting inside the
  // opponent's current weapon's max hit bites a berry without being told —
  // one per tick (a manual bite this tick counts), same swing delay as any
  // eat. Pure function of public state, so replays agree.
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    if (f.berries <= 0) continue;
    if (state.events.some((e) => e.kind === "eat" && e.actor === i)) continue;
    const foe = state.fighters[1 - i];
    if (f.hp > WEAPONS[foe.weapon].max) continue;
    f.berries -= 1;
    f.hp = Math.min(ARENA_HP, f.hp + BERRY_HEAL);
    f.nextSwing = Math.max(f.nextSwing, state.tick) + EAT_ATTACK_DELAY;
    state.events.push({
      tick: state.tick,
      actor: i,
      kind: "eat",
      value: BERRY_HEAL,
    });
  }

  // -- swings, fixed roll order, damage applied after both resolve
  const pending: [number, number] = [0, 0];
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    if (!f.engaged || state.tick < f.nextSwing) continue;
    const w = WEAPONS[f.weapon];
    f.nextSwing = state.tick + w.speed;

    const spec = f.specArmed && f.specEnergy >= SPEC_COST;
    if (spec) {
      f.specEnergy -= SPEC_COST;
      f.specArmed = false;
    }
    // the spec sharpens the roll as well as doubling the ceiling
    const acc = Math.min(1, w.acc + (spec ? SPEC_ACC_BONUS : 0));
    const max = spec ? w.max * 2 : w.max;
    const hitRoll = state.rng();
    const dmgRoll = state.rng(); // always drawn — fixed draws per swing
    if (hitRoll < acc) {
      const dmg = Math.floor(dmgRoll * (max + 1));
      pending[1 - i] += dmg;
      f.dmgDealt += dmg;
      state.events.push({
        tick: state.tick,
        actor: i,
        kind: spec ? "spec-hit" : "hit",
        value: dmg,
      });
    } else {
      state.events.push({
        tick: state.tick,
        actor: i,
        kind: spec ? "spec-miss" : "miss",
        value: 0,
      });
    }
  }

  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    f.hp = Math.max(0, f.hp - pending[i]);
  }

  state.tick += 1;

  const koA = state.fighters[0].hp === 0;
  const koB = state.fighters[1].hp === 0;
  if (koA || koB || state.tick >= MAX_TICKS) {
    state.over = true;
    if (koA && !koB) state.winner = 1;
    else if (koB && !koA) state.winner = 0;
    else if (koA && koB) state.winner = 2;
    else {
      const da = state.fighters[0].dmgDealt;
      const db = state.fighters[1].dmgDealt;
      state.winner = da > db ? 0 : db > da ? 1 : 2;
    }
    if (koA || koB) {
      state.events.push({
        tick: state.tick,
        actor: state.winner === 2 ? -1 : state.winner,
        kind: "ko",
        value: 0,
      });
    }
  }

  return state;
}

// ---------------------------------------------------------------- audit --

/** The server's per-tick record: both intents, exactly as applied. */
export type ArenaLog = Array<[ArenaIntent, ArenaIntent]>;

export interface ArenaResult {
  winner: number;
  ticks: number;
  hp: [number, number];
  dmg: [number, number];
  ko: boolean;
}

/**
 * Deterministic re-simulation from the seed and intent log. Anyone holding
 * a fight's log can verify the verdict the server announced — the audit
 * trail bids will eventually settle against.
 */
export function arenaReplay(
  seed: number,
  options: ArenaOptions,
  log: ArenaLog
): ArenaResult {
  const state = createArena(seed, options);
  for (const [a, b] of log) {
    if (state.over) break;
    stepArena(state, a, b);
  }
  return {
    winner: state.winner,
    ticks: state.tick,
    hp: [state.fighters[0].hp, state.fighters[1].hp],
    dmg: [state.fighters[0].dmgDealt, state.fighters[1].dmgDealt],
    ko: state.fighters[0].hp === 0 || state.fighters[1].hp === 0,
  };
}

/** Public snapshot for broadcast — everything both players may see
 *  (what you're holding is public, exactly like OSRS). */
export function arenaSnapshot(state: ArenaState) {
  return {
    tick: state.tick,
    over: state.over,
    winner: state.winner,
    fighters: state.fighters.map((f) => ({
      hp: f.hp,
      weapon: f.weapon,
      engaged: f.engaged,
      specEnergy: f.specEnergy,
      specArmed: f.specArmed,
      berries: f.berries,
      dmgDealt: f.dmgDealt,
      nextSwingIn: Math.max(0, f.nextSwing - state.tick),
    })),
    events: state.events,
  };
}
export type ArenaSnapshot = ReturnType<typeof arenaSnapshot>;
