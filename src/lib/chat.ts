// Chat message customization, shared by the API route (validation) and the
// panel (encoding + rendering). A message's avatar is the sender's wardrobe
// fit frozen at send time, encoded as a short string:
//   "f:<skin>,<hat>,<face>,<trail>,<charm>"  — custom wardrobe fit
//   "d:<cosmetic-id>"                        — the daily cosmetic worn that day
//   ""                                       — legacy / unknown → seed bird
// Parsing is strict: anything that doesn't name real pieces is rejected, so
// the DB never stores junk that later clients would have to tolerate.

import { COSMETICS, cosmeticForDay, type Cosmetic } from "@/game/cosmetics";
import {
  NONE,
  SLOTS,
  getPiece,
  loadFit,
  type Fit,
} from "@/game/wardrobe";

export const CHAT_FIT_MAX = 100;

// name colors — legible on paper in both themes; the server only stores
// colors from this list
export const CHAT_COLORS = [
  "#d95a13", "#4e8321", "#3d58d8", "#b5309a", "#b98f14", "#0f8a8a",
  "#e6533c", "#7a4fd0", "#d13030", "#0f6bb0", "#7d8a1e", "#c94f7c",
];

// message text effects — a fixed menu the server validates against, so the
// DB never stores an effect a client wouldn't know how to draw. "nudge" is
// deliberately not in this list: the server stamps it on nudge events and
// it can't be picked as a text style.
export const CHAT_EFFECTS = ["wave", "rainbow", "shake", "big"] as const;
export type ChatEffect = (typeof CHAT_EFFECTS)[number];
export const NUDGE_EFFECT = "nudge";

/** the effect if it names a real one, else plain */
export function parseChatEffect(v: unknown): string {
  return CHAT_EFFECTS.includes(v as ChatEffect) ? (v as string) : "";
}

// GIF messages: gif_url holds a URL from the chat picker (Giphy canonical
// or a Tenor tinygif), pinned to the two CDNs by shape — https only, no
// query string, .gif suffix. The API route refuses anything else at write
// time, and the panel re-checks before rendering an <img> from a DB row,
// so a row edited by hand can't make clients hotlink an arbitrary host.
const GIF_URL_MAX = 300;
const GIF_URL_RES = [
  /^https:\/\/media\.giphy\.com\/media\/[A-Za-z0-9]+\/200\.gif$/,
  /^https:\/\/media\.tenor\.com\/[A-Za-z0-9_-]+\/[^/?#]+\.gif$/,
];

/** the url if it's a well-formed picker gif, else "" (render as plain) */
export function parseChatGifUrl(v: unknown): string {
  return typeof v === "string" &&
    v.length <= GIF_URL_MAX &&
    GIF_URL_RES.some((re) => re.test(v))
    ? v
    : "";
}

// the fallback palette size is frozen at the original 8: growing the modulo
// would silently recolor every regular who never picked a swatch
const DERIVED_COLOR_COUNT = 8;

/** stable per-handle fallback so regulars are recognizable at a glance */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CHAT_COLORS[h % DERIVED_COLOR_COUNT];
}

/** What this browser's bird wears right now, as a chat-fit string. */
export function encodeChatFit(day: string): string {
  const fit = loadFit();
  if (fit) return `f:${SLOTS.map(({ slot }) => fit[slot]).join(",")}`;
  return `d:${cosmeticForDay(day).id}`;
}

export type ParsedChatFit = { fit: Fit } | { cosmetic: Cosmetic };

export function parseChatFit(s: string): ParsedChatFit | null {
  if (!s || s.length > CHAT_FIT_MAX) return null;
  if (s.startsWith("d:")) {
    const cosmetic = COSMETICS.find((c) => c.id === s.slice(2));
    return cosmetic ? { cosmetic } : null;
  }
  if (s.startsWith("f:")) {
    const parts = s.slice(2).split(",");
    if (parts.length !== SLOTS.length) return null;
    const fit = {} as Fit;
    for (let i = 0; i < SLOTS.length; i++) {
      const { slot } = SLOTS[i];
      const id = parts[i];
      const valid =
        (id === NONE && slot !== "skin") || getPiece(id)?.slot === slot;
      if (!valid) return null;
      fit[slot] = id;
    }
    return { fit };
  }
  return null;
}
