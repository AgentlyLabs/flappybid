import { BIRD_PALETTE, BIRD_SPRITE } from "@/game/sprite";
import { composeBird, cosmeticForDay } from "@/game/cosmetics";
import { utcDay } from "@/lib/day";

// Shared bits for the generated images (OG cards, apple icon).
//
// Two constraints shape the cards:
//   1. X overlays the link title as a chip across the BOTTOM-LEFT of the image,
//      so nothing load-bearing goes there. Branding lives in the top bar.
//   2. satori implements a subset of CSS on top of yoga. Flex only, no grid,
//      every element needs an explicit display, and absolutely positioned
//      elements resolve against their IMMEDIATE parent, not the nearest
//      positioned ancestor.

export const OG_SIZE = { width: 1200, height: 630 };

export const INK = "#26221c";
export const SKY = "#faf3e0";
export const PAPER = "#fffdf2";
export const GOLD = "#f5c842";
export const GOLD_DEEP = "#b98f14";
export const ORANGE = "#d95a13";
export const PIPE = "#73bf2e";
export const PIPE_LIGHT = "#9ce659";
export const PIPE_DARK = "#4e8321";
export const MUTED = "#8a8471";

/** The classic (undressed) bird. Prefer dailyBirdImage() for anything a
 * visitor sees the same day — it wears the daily cosmetic. */
export function birdDataUri(): string {
  const rects = BIRD_SPRITE.flatMap((row, y) =>
    Array.from(row).flatMap((ch, x) => {
      const fill = BIRD_PALETTE[ch];
      return fill
        ? [`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`]
        : [];
    })
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12" shape-rendering="crispEdges">${rects}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export interface BirdImage {
  uri: string;
  w: number;
  h: number;
}

/**
 * Today's bird, wearing the daily cosmetic, plus its natural pixel size —
 * the aspect ratio changes with the fit (hats add height, trails add width),
 * so callers size the <img> via fitBird() instead of hard-coding 16:12.
 */
export function dailyBirdImage(): BirdImage {
  const bird = composeBird(cosmeticForDay(utcDay()));
  const rects = bird.rows
    .flatMap((row, y) =>
      Array.from(row).flatMap((ch, x) => {
        const fill = bird.palette[ch];
        return fill
          ? [`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`]
          : [];
      })
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bird.w} ${bird.h}" shape-rendering="crispEdges">${rects}</svg>`;
  return {
    uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    w: bird.w,
    h: bird.h,
  };
}

/** Scale a BirdImage to fit a box, preserving its aspect ratio. */
export function fitBird(bird: BirdImage, maxW: number, maxH: number) {
  const s = Math.min(maxW / bird.w, maxH / bird.h);
  return { width: Math.round(bird.w * s), height: Math.round(bird.h * s) };
}

/** Press Start 2P as raw TTF for satori; node fetch gets the ttf variant */
export async function pixelFont(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      "https://fonts.googleapis.com/css2?family=Press+Start+2P",
      { next: { revalidate: 86400 } }
    ).then((r) => r.text());
    const url = css.match(/src:\s*url\((.+?)\)/)?.[1];
    if (!url) return null;
    return await fetch(url, { next: { revalidate: 86400 } }).then((r) =>
      r.arrayBuffer()
    );
  } catch {
    return null;
  }
}

/** VT323, for body copy that would be unreadable in Press Start 2P */
export async function bodyFont(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch("https://fonts.googleapis.com/css2?family=VT323", {
      next: { revalidate: 86400 },
    }).then((r) => r.text());
    const url = css.match(/src:\s*url\((.+?)\)/)?.[1];
    if (!url) return null;
    return await fetch(url, { next: { revalidate: 86400 } }).then((r) =>
      r.arrayBuffer()
    );
  } catch {
    return null;
  }
}

export interface OgFonts {
  pixel: ArrayBuffer | null;
  body: ArrayBuffer | null;
}

export async function ogFonts(): Promise<OgFonts> {
  const [pixel, body] = await Promise.all([pixelFont(), bodyFont()]);
  return { pixel, body };
}

export function fontSpec({ pixel, body }: OgFonts) {
  const fonts = [];
  if (pixel)
    fonts.push({ name: "PressStart", data: pixel, style: "normal" as const });
  if (body) fonts.push({ name: "VT323", data: body, style: "normal" as const });
  return fonts.length ? fonts : undefined;
}
