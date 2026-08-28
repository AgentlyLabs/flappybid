"use client";

import { useEffect, useState } from "react";
import { BIRD_SPRITE_H, BIRD_SPRITE_W } from "@/game/sprite";
import {
  composeBird,
  cosmeticForDay,
  type ComposedBird,
} from "@/game/cosmetics";
import { birdFrames, FIT_EVENT } from "@/game/wardrobe";
import { utcDay } from "@/lib/day";

// A composed bird rendered pixel-by-pixel as SVG rects. The viewBox stays
// anchored to the base 16x12 sprite so layouts never shift; hats and trails
// overflow the box instead (overflow-visible). crispEdges keeps the pixels
// hard at any size.
export function BirdSpriteSvg({
  bird,
  className = "",
}: {
  bird: ComposedBird;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${BIRD_SPRITE_W} ${BIRD_SPRITE_H}`}
      className={`overflow-visible ${className}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {bird.rows.flatMap((row, y) =>
        Array.from(row).map((ch, x) => {
          const fill = bird.palette[ch];
          if (!fill) return null;
          return (
            <rect
              key={`${x}-${y}`}
              x={x - bird.baseCol}
              y={y - bird.baseRow}
              width={1}
              height={1}
              fill={fill}
            />
          );
        })
      )}
    </svg>
  );
}

// The flappy bird as it looks right now: the visitor's saved wardrobe fit,
// or today's daily cosmetic when nothing is saved. Server-renders the daily
// bird (localStorage is client-only) and swaps to the custom fit on mount.
export default function PixelBird({ className = "" }: { className?: string }) {
  const [bird, setBird] = useState<ComposedBird | null>(null);
  useEffect(() => {
    const update = () => setBird(birdFrames(utcDay())[0]);
    update();
    window.addEventListener(FIT_EVENT, update);
    return () => window.removeEventListener(FIT_EVENT, update);
  }, []);
  return (
    <BirdSpriteSvg
      bird={bird ?? composeBird(cosmeticForDay(utcDay()))}
      className={className}
    />
  );
}
