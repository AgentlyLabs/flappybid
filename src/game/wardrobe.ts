// Player wardrobe: slot-based bird customization layered on top of the daily
// cosmetic system. Pieces are grouped into slots (skin / hat / face / trail /
// charm); a Fit picks one piece per slot and composes them into a single
// sprite. Most art is shared with the daily rotation in cosmetics.ts — a
// piece either references a daily cosmetic's grids or brings its own.
//
// Everything here is rendering-only and never touches the sim, so server
// replays are unaffected. The worn fit lives in localStorage (no auth), but
// most pieces are a paid unlock: ~20% of the rack (the starter basics) is
// free, and the rest cost coins and belong to the connected X @handle, so an
// owned piece follows the account across browsers (see cosmetics_owned +
// buy_cosmetic). Ownership only gates what the wardrobe will
// sell and equip — the fit itself is still client-side, so this is a
// monetization gate, not an anti-cheat boundary.

import {
  COSMETICS,
  composeBird,
  cosmeticForDay,
  type ComposedBird,
  type Cosmetic,
  type Overlay,
} from "./cosmetics";

export type Slot = "skin" | "hat" | "face" | "trail" | "charm";

export interface Piece {
  id: string;
  label: string;
  slot: Slot;
  /** base-palette overrides (uppercase keys) — skins */
  recolor?: Record<string, string>;
  palette?: Record<string, string>;
  overlays?: Overlay[];
  altOverlays?: Overlay[];
}

export interface Fit {
  skin: string;
  hat: string;
  face: string;
  trail: string;
  charm: string;
}

export const NONE = "none";

export const DEFAULT_FIT: Fit = {
  skin: "classic",
  hat: NONE,
  face: NONE,
  trail: NONE,
  charm: NONE,
};

export const SLOTS: { slot: Slot; label: string }[] = [
  { slot: "skin", label: "skin" },
  { slot: "hat", label: "hat" },
  { slot: "face", label: "face" },
  { slot: "trail", label: "trail" },
  { slot: "charm", label: "charm" },
];

// ------------------------------------------------------------------ catalog

const INK = "#26221c";
const GOLD = "#f5c842";

const byId = new Map(COSMETICS.map((c) => [c.id, c]));
function art(id: string): Cosmetic {
  const c = byId.get(id);
  if (!c) throw new Error(`wardrobe references missing cosmetic "${id}"`);
  return c;
}

export const PIECES: Piece[] = [
  // ------------------------------------------------------------------ skins
  { id: "classic", label: "classic", slot: "skin" },
  {
    id: "ninja",
    label: "ninja",
    slot: "skin",
    recolor: art("ninja").recolor,
    palette: art("ninja").palette,
    overlays: art("ninja").overlays,
  },
  {
    id: "robo",
    label: "robo",
    slot: "skin",
    recolor: art("robo").recolor,
    palette: art("robo").palette,
    overlays: art("robo").overlays,
    altOverlays: art("robo").altOverlays,
  },
  { id: "ghost", label: "ghost", slot: "skin", recolor: art("ghost").recolor },
  {
    id: "cardinal",
    label: "cardinal",
    slot: "skin",
    recolor: art("cardinal").recolor,
    palette: art("cardinal").palette,
    overlays: art("cardinal").overlays,
  },
  {
    id: "night-owl",
    label: "night owl",
    slot: "skin",
    recolor: art("night-owl").recolor,
  },
  {
    id: "mint",
    label: "mint",
    slot: "skin",
    recolor: { Y: "#7dd9a6", C: "#d9f7e8" },
  },
  {
    id: "bubblegum",
    label: "bubblegum",
    slot: "skin",
    recolor: { Y: "#f29cc5", C: "#fbdcec" },
  },
  {
    id: "golden",
    label: "golden",
    slot: "skin",
    recolor: { Y: "#ffd23e", C: "#fff0b0", W: "#fffbe8" },
  },
  {
    id: "obsidian",
    label: "obsidian",
    slot: "skin",
    recolor: { Y: "#3f3a33", C: "#5c554b" },
  },
  {
    id: "galaxy",
    label: "galaxy",
    slot: "skin",
    recolor: { Y: "#4c3f8f", C: "#7a6cc9", W: "#efeaff" },
    palette: { w: "#ffffff" },
    overlays: [
      { dx: 3, dy: 3, rows: ["w"] },
      { dx: 5, dy: 8, rows: ["w"] },
    ],
    altOverlays: [
      { dx: 2, dy: 6, rows: ["w"] },
      { dx: 6, dy: 2, rows: ["w"] },
    ],
  },
  {
    id: "phoenix",
    label: "phoenix",
    slot: "skin",
    recolor: { Y: "#f2762e", C: "#ffd23e", W: "#fff6e0", O: "#e8452a", D: "#b53220" },
    palette: { f: "#e8452a", y: GOLD },
    overlays: [
      {
        dx: -4,
        dy: 3,
        under: true,
        rows: ["..f..", ".fy..", "fyy..", ".f..."],
      },
    ],
    altOverlays: [
      {
        dx: -4,
        dy: 3,
        under: true,
        rows: [".f...", "fyy..", ".fy..", "..f.."],
      },
    ],
  },

  // ------------------------------------------------------------------- hats
  {
    id: "top-hat",
    label: "top hat",
    slot: "hat",
    palette: art("top-hat").palette,
    overlays: art("top-hat").overlays,
  },
  {
    id: "wizard",
    label: "wizard hat",
    slot: "hat",
    palette: art("wizard").palette,
    overlays: art("wizard").overlays,
  },
  {
    id: "crown",
    label: "crown",
    slot: "hat",
    palette: art("crown").palette,
    overlays: art("crown").overlays,
  },
  {
    id: "propeller",
    label: "propeller",
    slot: "hat",
    palette: art("propeller").palette,
    overlays: art("propeller").overlays,
    altOverlays: art("propeller").altOverlays,
  },
  {
    id: "viking",
    label: "viking helm",
    slot: "hat",
    palette: art("viking").palette,
    overlays: art("viking").overlays,
  },
  {
    id: "bandana",
    label: "bandana",
    slot: "hat",
    palette: { r: "#d92626" },
    overlays: [art("pirate").overlays![0]],
  },
  {
    id: "cowboy",
    label: "cowboy hat",
    slot: "hat",
    palette: art("cowboy").palette,
    overlays: art("cowboy").overlays,
  },
  {
    id: "chef",
    label: "chef hat",
    slot: "hat",
    palette: art("chef").palette,
    overlays: art("chef").overlays,
  },
  {
    id: "party-hat",
    label: "party hat",
    slot: "hat",
    palette: art("party").palette,
    overlays: [art("party").overlays![0]],
  },
  {
    id: "halo",
    label: "halo",
    slot: "hat",
    palette: art("halo").palette,
    overlays: art("halo").overlays,
  },
  {
    id: "headphones",
    label: "headphones",
    slot: "hat",
    palette: art("lofi").palette,
    overlays: art("lofi").overlays,
  },
  {
    id: "sprout",
    label: "sprout",
    slot: "hat",
    palette: art("sprout").palette,
    overlays: art("sprout").overlays,
  },
  {
    id: "beanie",
    label: "beanie",
    slot: "hat",
    palette: { r: "#e04646", d: "#a83232", w: "#ffffff" },
    overlays: [
      { dx: 7, dy: -4, rows: ["ww"] },
      { dx: 4, dy: -3, rows: ["..rrrr..", ".rrrrrr.", "dddddddd"] },
    ],
  },
  {
    id: "witch",
    label: "witch hat",
    slot: "hat",
    palette: art("witch").palette,
    overlays: art("witch").overlays,
  },
  {
    id: "santa",
    label: "santa hat",
    slot: "hat",
    palette: art("santa").palette,
    overlays: art("santa").overlays,
  },
  {
    id: "samurai",
    label: "samurai helm",
    slot: "hat",
    palette: { k: "#3a3630", g: GOLD },
    overlays: [
      {
        dx: 4,
        dy: -4,
        rows: ["....g....", "..g.g.g..", ".kkkkkkk.", "kkkkkkkkk"],
      },
    ],
  },
  {
    id: "dragon-horns",
    label: "dragon horns",
    slot: "hat",
    palette: { r: "#c23b2e", d: "#8f2620" },
    overlays: [
      {
        dx: 4,
        dy: -3,
        rows: ["r......r", "rr....rr", ".dr..rd."],
      },
    ],
  },

  // ------------------------------------------------------------------- face
  {
    id: "shades",
    label: "shades",
    slot: "face",
    palette: art("deal-with-it").palette,
    overlays: art("deal-with-it").overlays,
  },
  {
    id: "eyepatch",
    label: "eyepatch",
    slot: "face",
    palette: { k: INK },
    overlays: [art("pirate").overlays![1]],
  },
  {
    id: "monocle",
    label: "monocle",
    slot: "face",
    palette: { g: GOLD },
    overlays: [
      {
        dx: 8,
        dy: 1,
        rows: [".gggg.", "g....g", "g....g", "g....g", ".gggg."],
      },
      { dx: 13, dy: 6, rows: ["g.", ".g", ".g"] },
    ],
  },
  {
    id: "mustache",
    label: "mustache",
    slot: "face",
    palette: { k: INK },
    overlays: [{ dx: 7, dy: 8, rows: ["kkk.kkk", "k.....k"] }],
  },
  {
    id: "gold-shades",
    label: "gold shades",
    slot: "face",
    palette: { g: GOLD, d: "#c79a1e" },
    overlays: [
      { dx: 7, dy: 2, rows: ["ggggggg", ".gg.gg.", ".dd.dd."] },
    ],
  },

  // ------------------------------------------------------------------ trail
  {
    id: "afterburner",
    label: "afterburner",
    slot: "trail",
    palette: art("afterburner").palette,
    overlays: art("afterburner").overlays,
    altOverlays: art("afterburner").altOverlays,
  },
  {
    id: "sparkles",
    label: "sparkles",
    slot: "trail",
    palette: { y: GOLD, w: "#ffffff" },
    overlays: [
      {
        dx: -5,
        dy: 2,
        under: true,
        rows: ["y....", "...w.", ".y...", "....y"],
      },
    ],
    altOverlays: [
      {
        dx: -5,
        dy: 2,
        under: true,
        rows: ["..w..", "y....", "....y", ".y..."],
      },
    ],
  },
  {
    id: "rainbow",
    label: "rainbow",
    slot: "trail",
    palette: { r: "#e6533c", y: GOLD, b: "#3d58d8" },
    overlays: [
      {
        dx: -6,
        dy: 4,
        under: true,
        rows: ["rrrrrr", "yyyyyy", "bbbbbb"],
      },
    ],
    altOverlays: [
      {
        dx: -6,
        dy: 4,
        under: true,
        rows: [".rrrrr", ".yyyyy", ".bbbbb"],
      },
    ],
  },
  {
    id: "bubbles",
    label: "bubbles",
    slot: "trail",
    palette: { b: "#8fc7e8" },
    overlays: [
      {
        dx: -5,
        dy: 1,
        under: true,
        rows: ["..b..", "b....", "...b.", ".b..."],
      },
    ],
    altOverlays: [
      {
        dx: -5,
        dy: 1,
        under: true,
        rows: ["b....", "...b.", ".b...", "....b"],
      },
    ],
  },

  {
    id: "lightning",
    label: "lightning",
    slot: "trail",
    palette: { y: GOLD, w: "#ffffff" },
    overlays: [
      {
        dx: -6,
        dy: 3,
        under: true,
        rows: ["...yy.", "..yw..", ".yy...", "..y..."],
      },
    ],
    altOverlays: [
      {
        dx: -6,
        dy: 3,
        under: true,
        rows: ["..yy..", ".yw...", "..yy..", ".y...."],
      },
    ],
  },
  {
    id: "comet",
    label: "comet",
    slot: "trail",
    palette: { g: GOLD, w: "#ffffff" },
    overlays: [
      {
        dx: -7,
        dy: 4,
        under: true,
        rows: ["..gg..", "gwwggg", "..gg.."],
      },
    ],
    altOverlays: [
      {
        dx: -7,
        dy: 4,
        under: true,
        rows: [".gg...", ".wwggg", ".gg..."],
      },
    ],
  },

  // ------------------------------------------------------------------ charm
  {
    id: "confetti",
    label: "confetti",
    slot: "charm",
    palette: art("party").palette,
    overlays: art("party").overlays!.slice(1),
    altOverlays: art("party").altOverlays!.slice(1),
  },
  {
    id: "hearts",
    label: "hearts",
    slot: "charm",
    palette: art("lovestruck").palette,
    overlays: art("lovestruck").overlays,
    altOverlays: art("lovestruck").altOverlays,
  },
  {
    id: "fireflies",
    label: "fireflies",
    slot: "charm",
    palette: { y: GOLD },
    overlays: [
      { dx: -3, dy: 1, rows: ["y"] },
      { dx: -1, dy: -2, rows: ["y"] },
    ],
    altOverlays: [
      { dx: -2, dy: -1, rows: ["y"] },
      { dx: -1, dy: 2, rows: ["y"] },
    ],
  },
  {
    id: "twig",
    label: "twig",
    slot: "charm",
    palette: art("twig").palette,
    overlays: art("twig").overlays,
  },
  {
    id: "storm-cloud",
    label: "storm cloud",
    slot: "charm",
    palette: { s: "#b8c4cc", y: GOLD },
    overlays: [{ dx: -4, dy: -2, under: true, rows: [".sss.", "sssss"] }],
    altOverlays: [
      { dx: -4, dy: -2, under: true, rows: [".sss.", "sssss"] },
      { dx: -2, dy: 1, under: true, rows: ["y.", ".y"] },
    ],
  },
];

// --------------------------------------------------------------- pricing
// Paid pieces unlock with coins and stay owned on your X @handle. A cosmetic
// is a permanent, account-bound unlock, so it costs more than a one-shot
// revive (REVIVE_COST = 50 coins ≈ $1); rarer pieces cost more. Pricing is
// centralised here (not scattered across the catalog) and is the client's
// hint only — the buy route re-prices every purchase from this same table.

/** Coin price by tier. 50 coins ≈ $1. */
export const COST = { common: 75, rare: 150, epic: 300, legendary: 500 } as const;

// The free ~20%: one or two starter basics per slot, so a player with no coins
// (or no X connection) can still assemble a decent fit. Everything else is paid.
const FREE_PIECES = new Set<string>([
  "classic", "ghost", // skins
  "top-hat", "beanie", // hats
  "shades", "mustache", // face
  "sparkles", // trail
  "confetti", "hearts", // charm
]);

// Rarity by piece id — anything paid but unlisted here is common (COST.common).
const RARE = new Set<string>(["golden", "crown", "witch", "santa", "afterburner"]);
const EPIC = new Set<string>([
  "obsidian", "galaxy", "samurai", "gold-shades", "lightning", "storm-cloud",
]);
const LEGENDARY = new Set<string>(["phoenix", "dragon-horns", "comet"]);

/** Coin price to unlock a piece; 0 for the free starter basics. */
export function pieceCost(piece: Piece): number {
  if (FREE_PIECES.has(piece.id)) return 0;
  if (LEGENDARY.has(piece.id)) return COST.legendary;
  if (EPIC.has(piece.id)) return COST.epic;
  if (RARE.has(piece.id)) return COST.rare;
  return COST.common;
}

export function isFree(piece: Piece): boolean {
  return pieceCost(piece) === 0;
}

/** Wearable now: free pieces always, paid pieces once owned on the handle. */
export function canWear(piece: Piece, owned: ReadonlySet<string>): boolean {
  return isFree(piece) || owned.has(piece.id);
}

/** Server-authoritative price lookup by id (used by the buy route). */
export function costForPieceId(id: string): number | null {
  const p = pieceById.get(id);
  return p ? pieceCost(p) : null;
}

const pieceById = new Map(PIECES.map((p) => [p.id, p]));

export function getPiece(id: string): Piece | undefined {
  return pieceById.get(id);
}

export function piecesForSlot(slot: Slot): Piece[] {
  return PIECES.filter((p) => p.slot === slot);
}

// ---------------------------------------------------------------- composing

/**
 * Merge the fit's pieces into one synthetic Cosmetic and flatten it. Each
 * piece's palette letters are remapped to private-use characters so two
 * pieces can use the same letter for different colors without clobbering
 * each other (or the base sprite's uppercase letters).
 */
export function composeFit(fit: Fit, alt = false): ComposedBird {
  let recolor: Record<string, string> = {};
  const palette: Record<string, string> = {};
  const overlays: Overlay[] = [];
  const altOverlays: Overlay[] = [];
  let nextChar = 0xe000;

  for (const { slot } of SLOTS) {
    const piece = pieceById.get(fit[slot]);
    if (!piece || piece.slot !== slot) continue;
    if (piece.recolor) recolor = { ...recolor, ...piece.recolor };
    const map: Record<string, string> = {};
    for (const [ch, color] of Object.entries(piece.palette ?? {})) {
      const uniq = String.fromCharCode(nextChar++);
      map[ch] = uniq;
      palette[uniq] = color;
    }
    const remap = (os: Overlay[]) =>
      os.map((o) => ({
        ...o,
        rows: o.rows.map((row) =>
          Array.from(row, (ch) => (ch === "." ? "." : (map[ch] ?? "."))).join("")
        ),
      }));
    const base = remap(piece.overlays ?? []);
    overlays.push(...base);
    altOverlays.push(...(piece.altOverlays ? remap(piece.altOverlays) : base));
  }

  return composeBird(
    { id: "custom", label: "custom", recolor, palette, overlays, altOverlays },
    alt
  );
}

/** "top hat · shades · sparkles" — or the skin name, or "classic bird". */
export function fitLabel(fit: Fit): string {
  const parts = SLOTS.map(({ slot }) => {
    const id = fit[slot];
    if (id === NONE || (slot === "skin" && id === "classic")) return null;
    return pieceById.get(id)?.label ?? null;
  }).filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : "classic bird";
}

// -------------------------------------------------------- persistence + fit

const FIT_KEY = "fb_fit";
export const FIT_EVENT = "fb:fit-change";

function sanitizeFit(raw: unknown): Fit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fit = { ...DEFAULT_FIT };
  for (const { slot } of SLOTS) {
    const id = r[slot];
    if (typeof id !== "string") continue;
    if (id === NONE && slot !== "skin") fit[slot] = NONE;
    else if (pieceById.get(id)?.slot === slot) fit[slot] = id;
  }
  return fit;
}

/** The saved custom fit, or null when the bird wears the daily rotation. */
export function loadFit(): Fit | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(FIT_KEY);
    return raw ? sanitizeFit(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Persist a custom fit; null reverts to the daily rotation. */
export function saveFit(fit: Fit | null) {
  try {
    if (fit) localStorage.setItem(FIT_KEY, JSON.stringify(fit));
    else localStorage.removeItem(FIT_KEY);
  } catch {
    // private mode etc. — the fit still applies for this page's lifetime
  }
  frameCacheKey = ""; // recompose on next draw
  window.dispatchEvent(new CustomEvent(FIT_EVENT));
}

export function currentFitInfo(day: string): { label: string; custom: boolean } {
  const fit = loadFit();
  return fit
    ? { label: fitLabel(fit), custom: true }
    : { label: cosmeticForDay(day).label, custom: false };
}

/**
 * The two animation frames the bird wears right now — the custom fit when
 * one is saved, otherwise the daily cosmetic. Cached until the day flips or
 * the fit changes; cheap enough to call every canvas frame.
 */
let frameCacheKey = "";
let frameCache: [ComposedBird, ComposedBird] | null = null;
export function birdFrames(day: string): [ComposedBird, ComposedBird] {
  if (!frameCache || frameCacheKey !== day) {
    const fit = loadFit();
    frameCache = fit
      ? [composeFit(fit, false), composeFit(fit, true)]
      : [
          composeBird(cosmeticForDay(day), false),
          composeBird(cosmeticForDay(day), true),
        ];
    frameCacheKey = day;
  }
  return frameCache;
}

// ---------------------------------------------------------- stats + shuffle

const STATS_KEY = "fb_stats";
export const STATS_EVENT = "fb:stats-change";

export interface LocalStats {
  best: number;
  runs: number;
}

export function loadStats(): LocalStats {
  if (typeof window === "undefined") return { best: 0, runs: 0 };
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<LocalStats>;
      return {
        best: typeof s.best === "number" ? s.best : 0,
        runs: typeof s.runs === "number" ? s.runs : 0,
      };
    }
  } catch {
    // fall through
  }
  return { best: 0, runs: 0 };
}

/** Called after every verified run; tracks local best/run count for display. */
export function recordRun(score: number) {
  const s = loadStats();
  const next = { best: Math.max(s.best, score), runs: s.runs + 1 };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(next));
  } catch {
    // non-persistent is fine
  }
  window.dispatchEvent(new CustomEvent(STATS_EVENT));
}

/** A random fit from wearable pieces ("none" stays in the pool per slot). */
export function randomFit(owned: ReadonlySet<string>): Fit {
  const fit = { ...DEFAULT_FIT };
  for (const { slot } of SLOTS) {
    const pool = piecesForSlot(slot)
      .filter((p) => canWear(p, owned))
      .map((p) => p.id);
    if (slot !== "skin") pool.push(NONE);
    fit[slot] = pool[Math.floor(Math.random() * pool.length)];
  }
  return fit;
}
