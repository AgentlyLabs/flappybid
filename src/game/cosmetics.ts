// Daily cosmetics: every UTC day the bird wears a new look — hats, palette
// swaps, whole character re-skins, even fire out the back. The pick is a pure
// hash of the date, so every visitor sees the same bird and it flips exactly
// at 00:00 UTC with no cron or DB involved. Cosmetics are rendering-only and
// never touch the sim, so server replays are unaffected.
//
// Overlay grids use lowercase palette letters (base sprite letters are
// uppercase) so a cosmetic can never accidentally recolor the bird itself.

import {
  BIRD_PALETTE,
  BIRD_SPRITE,
  BIRD_SPRITE_H,
  BIRD_SPRITE_W,
} from "./sprite";

export interface Overlay {
  /** column of the grid's left edge relative to base sprite col 0 (can be negative) */
  dx: number;
  /** row of the grid's top edge relative to base sprite row 0 (negative = above the head) */
  dy: number;
  rows: string[];
  /** draw behind the bird instead of on top (trails, jets) */
  under?: boolean;
}

export interface Cosmetic {
  id: string;
  /** shown on the homepage: "today's fit: <label>" */
  label: string;
  /** base-palette overrides (uppercase keys) for character/color swaps */
  recolor?: Record<string, string>;
  /** colors for the lowercase letters used in overlays */
  palette?: Record<string, string>;
  overlays?: Overlay[];
  /** alternate animation frame (canvas flickers between the two); falls back to overlays */
  altOverlays?: Overlay[];
  /** only appears via the special-dates table, never in the normal rotation */
  seasonalOnly?: boolean;
}

const INK = "#26221c";
const GOLD = "#f5c842";
const RED = "#d92626";
const BLUE = "#3d58d8";
const GREEN = "#3fbf6f";

export const COSMETICS: Cosmetic[] = [
  {
    id: "top-hat",
    label: "dapper bird",
    palette: { k: INK, r: RED },
    overlays: [
      {
        dx: 4,
        dy: -5,
        rows: [
          ".kkkkkkk.",
          ".kkkkkkk.",
          ".kkkkkkk.",
          ".rrrrrrr.",
          "kkkkkkkkk",
        ],
      },
    ],
  },
  {
    id: "wizard",
    label: "wizard bird",
    palette: { b: BLUE, d: "#2c3fa3", s: GOLD },
    overlays: [
      {
        dx: 3,
        dy: -7,
        rows: [
          ".....bb....",
          ".....bb....",
          "....bbbb...",
          "....bbbb...",
          "...bbsbb...",
          "..bbbbbbb..",
          ".bbbbbbbbb.",
          "ddddddddddd",
        ],
      },
    ],
  },
  {
    id: "crown",
    label: "king of the day",
    palette: { g: GOLD, r: "#e04646", b: BLUE, d: "#c79a1e" },
    overlays: [
      {
        dx: 5,
        dy: -4,
        rows: ["g.g.g.g", "ggggggg", "grgbgrg", "ddddddd"],
      },
    ],
  },
  {
    id: "propeller",
    label: "propeller head",
    palette: { k: INK, r: "#e04646", b: BLUE, s: "#c8d1da" },
    overlays: [
      { dx: 2, dy: -5, rows: ["sssss.sssss"] },
      { dx: 7, dy: -5, rows: ["k", "k"] },
      { dx: 4, dy: -3, rows: ["..kkk..", ".rbrbr.", "rbrbrbr"] },
    ],
    altOverlays: [
      { dx: 5, dy: -5, rows: ["ss.ss"] },
      { dx: 7, dy: -5, rows: ["k", "k"] },
      { dx: 4, dy: -3, rows: ["..kkk..", ".rbrbr.", "rbrbrbr"] },
    ],
  },
  {
    id: "deal-with-it",
    label: "deal with it",
    palette: { k: INK, w: "#ffffff" },
    overlays: [
      {
        dx: 5,
        dy: 2,
        rows: ["kkkkkkkkk", "...kwkkkk", "...kkkkk."],
      },
    ],
  },
  {
    id: "afterburner",
    label: "afterburner",
    palette: { r: "#e23c1e", o: "#ff8c1a", y: "#ffd23e", w: "#fff7d6" },
    overlays: [
      {
        dx: -5,
        dy: 4,
        under: true,
        rows: ["...roo", ".royyo", "roywyo", ".royyo", "...roo"],
      },
    ],
    altOverlays: [
      {
        dx: -5,
        dy: 4,
        under: true,
        rows: ["....ro", "..royo", ".roywo", "..royo", "....ro"],
      },
    ],
  },
  {
    id: "viking",
    label: "viking bird",
    palette: { s: "#b9c2cc", h: "#f2e3c8" },
    overlays: [
      {
        dx: 3,
        dy: -4,
        rows: [
          "h.........h",
          "h..sssss..h",
          "hh.sssss.hh",
          ".sssssssss.",
        ],
      },
    ],
  },
  {
    id: "pirate",
    label: "pirate bird",
    palette: { r: RED, k: INK },
    overlays: [
      {
        dx: 2,
        dy: -1,
        rows: [
          "..rrrrrrr...",
          ".rrrrrrrrrr.",
          "rrrrrrrrrrr.",
          ".rr.........",
        ],
      },
      {
        dx: 5,
        dy: 3,
        rows: ["kkkkkkkkk", "....kkk..", "....kkk.."],
      },
    ],
  },
  {
    id: "cowboy",
    label: "yeehaw bird",
    palette: { n: "#8a5a2b", d: "#5e3a19" },
    overlays: [
      {
        dx: 3,
        dy: -4,
        rows: ["...nnnn...", "...nnnn...", "...dddd...", "nnnnnnnnnn"],
      },
    ],
  },
  {
    id: "ninja",
    label: "ninja bird",
    recolor: { Y: "#5f7186", C: "#8fa2b8" },
    palette: { r: RED },
    overlays: [
      {
        dx: 1,
        dy: 1,
        rows: ["...rrrrrrrrr", "rr..........", "r...........", ".r.........."],
      },
    ],
  },
  {
    id: "robo",
    label: "robo bird",
    recolor: { Y: "#9aa5b1", C: "#c8d1da" },
    palette: { k: INK, r: "#e04646", y: GOLD },
    overlays: [{ dx: 8, dy: -3, rows: ["r", "k", "k"] }],
    altOverlays: [{ dx: 8, dy: -3, rows: ["y", "k", "k"] }],
  },
  {
    id: "ghost",
    label: "ghost bird",
    recolor: {
      K: "#4a5875",
      Y: "#cfe0f2",
      C: "#eef5fc",
      O: "#9fb4cf",
      D: "#8296b4",
    },
  },
  {
    id: "cardinal",
    label: "cardinal bird",
    recolor: { Y: "#d63c31", C: "#ef8d80" },
    palette: { r: "#d63c31" },
    overlays: [{ dx: 8, dy: -2, rows: [".rr", "rr."] }],
  },
  {
    id: "night-owl",
    label: "night owl",
    recolor: { Y: "#5a4a7a", C: "#8d7bb3" },
    palette: { y: GOLD },
    overlays: [
      { dx: -3, dy: 1, rows: ["y"] },
      { dx: -1, dy: -2, rows: ["y"] },
    ],
  },
  {
    id: "party",
    label: "party bird",
    palette: { p: "#e04646", g: GREEN, b: BLUE, y: GOLD, w: "#ffffff" },
    overlays: [
      {
        dx: 6,
        dy: -6,
        rows: ["..w..", "..p..", "..b..", ".ggg.", ".ppp.", "bbbbb"],
      },
      { dx: 2, dy: -4, rows: ["p"] },
      { dx: 13, dy: -5, rows: ["g"] },
      { dx: 0, dy: -1, rows: ["b"] },
      { dx: 14, dy: -2, rows: ["y"] },
    ],
    altOverlays: [
      {
        dx: 6,
        dy: -6,
        rows: ["..w..", "..p..", "..b..", ".ggg.", ".ppp.", "bbbbb"],
      },
      { dx: 3, dy: -6, rows: ["g"] },
      { dx: 12, dy: -3, rows: ["y"] },
      { dx: 1, dy: -3, rows: ["p"] },
      { dx: 15, dy: -4, rows: ["b"] },
    ],
  },
  {
    id: "halo",
    label: "angel bird",
    palette: { g: GOLD },
    overlays: [{ dx: 5, dy: -4, rows: [".ggggg.", "g.....g", ".ggggg."] }],
  },
  {
    id: "chef",
    label: "chef bird",
    palette: { w: "#ffffff", s: "#d9d4c8" },
    overlays: [
      {
        dx: 3,
        dy: -4,
        rows: [".wwwwwww.", "wwwwwwwww", "wwwwwwwww", ".sssssss."],
      },
    ],
  },
  {
    id: "sprout",
    label: "sprout bird",
    palette: { g: GREEN, l: "#7ade9e" },
    overlays: [{ dx: 8, dy: -3, rows: ["l.l", "lgl", ".g."] }],
  },
  {
    id: "lofi",
    label: "lo-fi bird",
    palette: { k: INK, o: "#ff8c1a" },
    overlays: [
      { dx: 4, dy: -2, rows: [".kkkkkkk.", "k.......k"] },
      { dx: 4, dy: 0, rows: ["kk", "ko", "kk"] },
    ],
  },
  {
    id: "twig",
    label: "nest builder",
    palette: { n: "#8a5a2b", l: "#a8763d" },
    overlays: [
      {
        dx: 11,
        dy: 5,
        rows: [".......nn", ".....nl..", "...nl....", ".nl......", "nn......."],
      },
    ],
  },
  // ------------------------------------------------ seasonal (special dates)
  {
    id: "santa",
    label: "santa bird",
    seasonalOnly: true,
    palette: { r: RED, w: "#ffffff" },
    overlays: [
      {
        dx: 3,
        dy: -5,
        rows: [
          "......ww..",
          "....rrw...",
          "...rrrr...",
          "..rrrrr...",
          ".rrrrrr...",
          "wwwwwwwww.",
        ],
      },
    ],
  },
  {
    id: "witch",
    label: "witch bird",
    seasonalOnly: true,
    palette: { p: "#5a3a8a", y: GOLD },
    overlays: [
      {
        dx: 2,
        dy: -6,
        rows: [
          ".....ppp....",
          ".....ppp....",
          "....ppppp...",
          "....ppppp...",
          "...ppyppp...",
          "pppppppppppp",
        ],
      },
    ],
  },
  {
    id: "lovestruck",
    label: "lovestruck bird",
    seasonalOnly: true,
    palette: { r: "#e0426e" },
    overlays: [
      { dx: 6, dy: -5, rows: [".r.r.", "rrrrr", ".rrr.", "..r.."] },
      { dx: 13, dy: -2, rows: ["r"] },
    ],
    altOverlays: [
      { dx: 6, dy: -5, rows: [".r.r.", "rrrrr", ".rrr.", "..r.."] },
      { dx: 1, dy: -3, rows: ["r"] },
    ],
  },
];

/** MM-DD → cosmetic id. Overrides the rotation on special days. */
const SPECIAL_DATES: Record<string, string> = {
  "01-01": "party",
  "02-14": "lovestruck",
  "10-31": "witch",
  "12-25": "santa",
};

const ROTATION = COSMETICS.filter((c) => !c.seasonalOnly);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rotationIndex(day: string): number {
  return fnv1a(day) % ROTATION.length;
}

/** The cosmetic for a UTC day ("YYYY-MM-DD"). Pure — same input, same fit. */
export function cosmeticForDay(day: string): Cosmetic {
  const special = SPECIAL_DATES[day.slice(5)];
  if (special) {
    const c = COSMETICS.find((c) => c.id === special);
    if (c) return c;
  }
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  let idx = rotationIndex(day);
  // never wear the same fit two days running
  if (idx === rotationIndex(prev)) idx = (idx + 1) % ROTATION.length;
  return ROTATION[idx];
}

export interface ComposedBird {
  rows: string[];
  w: number;
  h: number;
  /** where base-sprite (0,0) sits inside `rows` */
  baseCol: number;
  baseRow: number;
  palette: Record<string, string>;
}

/** Flatten base sprite + cosmetic into one pixel grid with a merged palette. */
export function composeBird(cosmetic: Cosmetic, alt = false): ComposedBird {
  const overlays =
    (alt ? cosmetic.altOverlays : undefined) ?? cosmetic.overlays ?? [];

  let minX = 0;
  let minY = 0;
  let maxX = BIRD_SPRITE_W - 1;
  let maxY = BIRD_SPRITE_H - 1;
  for (const o of overlays) {
    minX = Math.min(minX, o.dx);
    minY = Math.min(minY, o.dy);
    maxX = Math.max(maxX, o.dx + Math.max(...o.rows.map((r) => r.length)) - 1);
    maxY = Math.max(maxY, o.dy + o.rows.length - 1);
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const grid: string[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => ".")
  );

  const paint = (o: Overlay) => {
    o.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === ".") continue;
        grid[o.dy + y - minY][o.dx + x - minX] = row[x];
      }
    });
  };

  for (const o of overlays) if (o.under) paint(o);
  paint({ dx: 0, dy: 0, rows: BIRD_SPRITE });
  for (const o of overlays) if (!o.under) paint(o);

  return {
    rows: grid.map((r) => r.join("")),
    w,
    h,
    baseCol: -minX,
    baseRow: -minY,
    palette: {
      ...BIRD_PALETTE,
      ...cosmetic.recolor,
      ...cosmetic.palette,
    },
  };
}
