"use client";

import { useEffect, useState } from "react";

// Favicons arrive with arbitrary baked-in padding (transparent margins,
// white matte, off-center letterboxing — Google's service pads agently.dev's
// icon with a white band on the right/bottom, for example). To make them fill
// the pixel frame exactly, we load the image on a canvas, find the bounding
// box of the actual artwork (anything that isn't the background color, which
// must appear in at least 3 of the 4 corners — a corner the artwork itself
// touches doesn't count), and re-crop to a square around it. Icons come from
// our same-origin /api/icon proxy, so the canvas is never CORS-tainted; the
// zoom fallback stays as a belt-and-braces path.

const FALLBACK_SRC = "/fallback-icon.svg";

const trimCache = new Map<string, string>();

function trim(img: HTMLImageElement): string | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h); // throws if CORS-tainted

  const px = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const similar = (p: number[], q: number[]) =>
    Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 36;
  // a corner color counts as background only if ~3 of 4 corners agree on it;
  // a lone corner the artwork touches must not erase the artwork as "bg"
  const bgRefs = corners.filter(
    (c) =>
      c[3] >= 16 &&
      corners.filter((o) => o[3] >= 16 && similar(c, o)).length >= 3
  );
  const isBg = (x: number, y: number) => {
    const p = px(x, y);
    if (p[3] < 16) return true;
    return bgRefs.some((c) => similar(p, c));
  };
  const rowBg = (y: number) => {
    for (let x = 0; x < w; x++) if (!isBg(x, y)) return false;
    return true;
  };
  const colBg = (x: number) => {
    for (let y = 0; y < h; y++) if (!isBg(x, y)) return false;
    return true;
  };

  let top = 0,
    bottom = h - 1,
    left = 0,
    right = w - 1;
  while (top < bottom && rowBg(top)) top++;
  while (bottom > top && rowBg(bottom)) bottom--;
  while (left < right && colBg(left)) left++;
  while (right > left && colBg(right)) right--;

  const bw = right - left + 1;
  const bh = bottom - top + 1;
  if (bw < 4 || bh < 4) return null; // solid/blank icon — leave as is
  if (bw >= w - 1 && bh >= h - 1) return null; // already full-bleed

  // square crop centered on the artwork
  const size = Math.max(bw, bh);
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.drawImage(c, left, top, bw, bh, (size - bw) / 2, (size - bh) / 2, bw, bh);
  return out.toDataURL();
}

export default function Favicon({
  src,
  alt = "",
}: {
  src: string;
  alt?: string;
}) {
  const [displaySrc, setDisplaySrc] = useState(() => trimCache.get(src) ?? src);
  const [fallbackZoom, setFallbackZoom] = useState(false);

  useEffect(() => {
    const cached = trimCache.get(src);
    if (cached) {
      setDisplaySrc(cached);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const trimmed = trim(img);
        trimCache.set(src, trimmed ?? src);
        if (trimmed) setDisplaySrc(trimmed);
      } catch {
        // canvas tainted — approximate with a zoom instead
        setFallbackZoom(true);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      style={fallbackZoom ? { transform: "scale(1.2)" } : undefined}
      onError={() => {
        // /api/icon redirects to this itself when no favicon exists; this
        // catches the proxy being unreachable outright
        if (displaySrc !== FALLBACK_SRC) setDisplaySrc(FALLBACK_SRC);
      }}
    />
  );
}
