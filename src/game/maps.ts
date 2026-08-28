// Maps. The player picks one on the ready screen; run/start freezes the
// choice onto the run row, because the server must replay the exact same
// course. mapForDay() still rotates a *featured* map per UTC day — it's the
// picker's default, nothing more. All maps score onto the same daily board;
// difficulty differences are part of the game, not a fairness bug.
//
// A map is physics + pipe-pattern + palette. Physics values feed the
// deterministic sim on BOTH sides (see sim.ts), so a map must never change
// once anyone has played a run on it — tuning an existing map is a sim
// change and needs a SIM_VERSION bump plus a fresh map id. The `classic`
// map must stay bit-identical to the pre-maps game forever: every replay
// stored before maps existed re-simulates through it.

import {
  GRAVITY,
  FLAP_IMPULSE,
  MAX_FALL_SPEED,
  SCROLL_SPEED,
  PIPE_GAP,
  PIPE_SPACING,
  GAP_CENTER_MIN,
  GAP_CENTER_MAX,
} from "./constants";
import { fnv1a } from "./rng";

export type MapId =
  | "classic"
  | "sway"
  | "cavern"
  | "turbo"
  | "moon"
  | "zigzag"
  | "gauntlet"
  | "alley"
  | "reactor";

/**
 * Per-map shooting rules. Frozen once anyone has played the map, exactly
 * like physics: these numbers feed the deterministic sim on both sides.
 * The rng draw count per pipe must stay fixed for a given map — targets
 * always burn 2 draws, and laser gates burn 2 more whenever laserChance > 0.
 */
export interface CombatDef {
  /** "gun" fires pipe-blocked bullets; "beam" is a piercing full-screen laser */
  weapon: "gun" | "beam";
  /** frames between shots */
  cooldown: number;
  /** chance a pipe segment carries a drone */
  targetChance: number;
  /** points per drone shot down */
  targetBonus: number;
  /** chance a pipe gap mounts a laser gate; 0 = no gates (and no rng draws) */
  laserChance: number;
  /** frames per warn→fire→idle gate cycle */
  laserPeriod: number;
  /** blinking telegraph frames at the start of the cycle */
  laserWarn: number;
  /** lethal frames right after the telegraph */
  laserFire: number;
}

export interface MapTheme {
  sky: string;
  cloudBand: string;
  bushBand: string;
  pipeBody: string;
  pipeLight: string;
  pipeDark: string;
}

export interface MapDef {
  id: MapId;
  label: string;
  /** one-liner for the ready screen */
  blurb: string;
  gravity: number;
  flapImpulse: number;
  maxFallSpeed: number;
  scrollSpeed: number;
  pipeGap: number;
  pipeSpacing: number;
  gapCenterMin: number;
  gapCenterMax: number;
  /** px the whole gap sways vertically; 0 = static pipes */
  waveAmp: number;
  /** frames per full sway cycle (ignored when waveAmp is 0) */
  wavePeriod: number;
  /** max px the gap center drifts between neighbours; null = uniform random */
  meanderStep: number | null;
  /** alternate low/high gap bands instead of uniform centers */
  zigzag: boolean;
  /** shooting mechanics (extra rng draws per pipe); null = no weapons */
  combat: CombatDef | null;
  theme: MapTheme;
}

const CLASSIC_THEME: MapTheme = {
  sky: "#70c5ce",
  cloudBand: "#e9fbe8",
  bushBand: "#a8e07a",
  pipeBody: "#73bf2e",
  pipeLight: "#9ce659",
  pipeDark: "#4e8321",
};

const base = {
  gravity: GRAVITY,
  flapImpulse: FLAP_IMPULSE,
  maxFallSpeed: MAX_FALL_SPEED,
  scrollSpeed: SCROLL_SPEED,
  pipeGap: PIPE_GAP,
  pipeSpacing: PIPE_SPACING,
  gapCenterMin: GAP_CENTER_MIN,
  gapCenterMax: GAP_CENTER_MAX,
  waveAmp: 0,
  wavePeriod: 1,
  meanderStep: null,
  zigzag: false,
  combat: null,
} as const;

export const MAPS: Record<MapId, MapDef> = {
  classic: {
    ...base,
    id: "classic",
    label: "classic meadow",
    blurb: "the original pipes",
    theme: CLASSIC_THEME,
  },

  // guns out: shoot floating drones for bonus points, laser gates close the
  // pipe gaps on a cycle — wider gaps because attention is split three ways
  gauntlet: {
    ...base,
    id: "gauntlet",
    label: "the gauntlet",
    blurb: "shoot the drones, time the lasers",
    pipeGap: 155,
    pipeSpacing: 245,
    combat: {
      weapon: "gun",
      cooldown: 13,
      targetChance: 0.65,
      targetBonus: 3,
      laserChance: 0.52,
      laserPeriod: 140,
      laserWarn: 40,
      laserFire: 32,
    },
    theme: {
      sky: "#2b1e3e",
      cloudBand: "#463060",
      bushBand: "#5c3d78",
      pipeBody: "#8a4fbf",
      pipeLight: "#b57fe6",
      pipeDark: "#5c3387",
    },
  },

  // neon target range: drones everywhere and quick, twitchy laser gates —
  // smaller bonus per drone, but the sky is full of them
  alley: {
    ...base,
    id: "alley",
    label: "drone alley",
    blurb: "a neon shooting gallery — drones everywhere",
    scrollSpeed: 3.1,
    pipeGap: 156,
    pipeSpacing: 232,
    combat: {
      weapon: "gun",
      cooldown: 11,
      targetChance: 0.9,
      targetBonus: 2,
      laserChance: 0.38,
      laserPeriod: 112,
      laserWarn: 30,
      laserFire: 26,
    },
    theme: {
      sky: "#141b33",
      cloudBand: "#232e52",
      bushBand: "#31406e",
      pipeBody: "#e0508f",
      pipeLight: "#ff8ec2",
      pipeDark: "#9c2f60",
    },
  },

  // the bird mounts a chargeable mega-laser: one shot vaporizes every drone
  // on its line clean across the screen, straight through the pipes — then
  // a long recharge while the reactor's own gates keep cycling
  reactor: {
    ...base,
    id: "reactor",
    label: "the reactor",
    blurb: "charge the mega laser, vaporize whole rows",
    pipeGap: 158,
    pipeSpacing: 248,
    combat: {
      weapon: "beam",
      cooldown: 100,
      targetChance: 0.8,
      targetBonus: 3,
      laserChance: 0.57,
      laserPeriod: 168,
      laserWarn: 43,
      laserFire: 37,
    },
    theme: {
      sky: "#101b12",
      cloudBand: "#1c2f1e",
      bushBand: "#28422a",
      pipeBody: "#3fae5a",
      pipeLight: "#7de291",
      pipeDark: "#256e38",
    },
  },

  // pipes sway up and down while they approach — wider gap to compensate
  sway: {
    ...base,
    id: "sway",
    label: "windy heights",
    blurb: "the pipes sway — time your line",
    pipeGap: 160,
    pipeSpacing: 238,
    // sway with a gentler amp; the center band keeps the swayed gap on-screen
    gapCenterMin: 145,
    gapCenterMax: 435,
    waveAmp: 52,
    wavePeriod: 158,
    theme: {
      sky: "#9adfe8",
      cloudBand: "#f2fdf7",
      bushBand: "#b8e6a0",
      pipeBody: "#86c45a",
      pipeLight: "#b5e88a",
      pipeDark: "#5a8f37",
    },
  },

  // gap centers random-walk instead of jumping — a winding stone tunnel
  cavern: {
    ...base,
    id: "cavern",
    label: "the cavern",
    blurb: "a winding tunnel, tight and dark",
    pipeGap: 138,
    pipeSpacing: 195,
    meanderStep: 155,
    theme: {
      sky: "#3c4756",
      cloudBand: "#4d5a6b",
      bushBand: "#5d6f80",
      pipeBody: "#8d8d99",
      pipeLight: "#b5b5c2",
      pipeDark: "#5f5f6b",
    },
  },

  // everything comes at you faster; wider gap and spacing keep it fair
  turbo: {
    ...base,
    id: "turbo",
    label: "rush hour",
    blurb: "everything comes at you faster",
    scrollSpeed: 4.05,
    pipeGap: 160,
    pipeSpacing: 255,
    theme: {
      sky: "#f7a15e",
      cloudBand: "#ffe6c9",
      bushBand: "#c96f3b",
      pipeBody: "#c94f3f",
      pipeLight: "#ef8368",
      pipeDark: "#8e3325",
    },
  },

  // low gravity: floaty flaps, slow dives, slimmer gaps
  moon: {
    ...base,
    id: "moon",
    label: "moonwalk",
    blurb: "low gravity — floaty flaps, slim gaps",
    gravity: 0.31,
    flapImpulse: -5.8,
    maxFallSpeed: 8.2,
    scrollSpeed: 2.7,
    pipeGap: 136,
    theme: {
      sky: "#1c2340",
      cloudBand: "#2c3560",
      bushBand: "#3a4670",
      pipeBody: "#9d8fd4",
      pipeLight: "#c4b8ef",
      pipeDark: "#6b5fa0",
    },
  },

  // gaps alternate low band / high band: climb, dive, repeat
  zigzag: {
    ...base,
    id: "zigzag",
    label: "the staircase",
    blurb: "climb, dive, repeat",
    scrollSpeed: 3.1,
    pipeGap: 155,
    pipeSpacing: 245,
    zigzag: true,
    theme: {
      sky: "#ffc2d9",
      cloudBand: "#fff0f6",
      bushBand: "#a8e07a",
      pipeBody: "#4fa8d8",
      pipeLight: "#8ed1f2",
      pipeDark: "#2f6f96",
    },
  },
};

/** Picker order; also the id validator for the run/start API. */
export const MAP_LIST: MapDef[] = Object.values(MAPS);

export function isMapId(id: unknown): id is MapId {
  return typeof id === "string" && id in MAPS;
}

/** First UTC day that rotates: every earlier day was (and stays) classic. */
export const MAPS_START = "2026-08-22";

const ROTATION: MapId[] = [
  "classic",
  "sway",
  "cavern",
  "turbo",
  "moon",
  "zigzag",
  "gauntlet",
  "alley",
  "reactor",
];

// salted so the map rotation doesn't correlate with the cosmetic rotation
function rotationId(day: string): MapId {
  return ROTATION[fnv1a(`map:${day}`) % ROTATION.length];
}

/** The map for a UTC day ("YYYY-MM-DD"). Pure — same input, same map. */
export function mapForDay(day: string): MapDef {
  if (day < MAPS_START) return MAPS.classic;
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  // never the same map two days running (vs the previous day's raw pick —
  // same accepted quirk as cosmeticForDay)
  const prevId = prev < MAPS_START ? "classic" : rotationId(prev);
  let idx = ROTATION.indexOf(rotationId(day));
  if (ROTATION[idx] === prevId) idx = (idx + 1) % ROTATION.length;
  return MAPS[ROTATION[idx]];
}
