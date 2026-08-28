"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Live HH:MM:SS to the next 00:00 UTC — the same clock the main board's
// CountdownInline runs. When it crosses midnight the board has closed, so it
// pulls the page fresh: the banner is server-rendered and reigningDuelChampion
// lazily crowns the day's leader on the first read after the close, so a
// refresh here is all it takes for the new crown to appear in place.
function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    sec
  ).padStart(2, "0")}`;
}

export default function DuelCloseCountdown({
  className,
}: {
  className?: string;
}) {
  const [left, setLeft] = useState("");
  const router = useRouter();
  const dayRef = useRef<string | null>(null);
  const crossedRef = useRef(false);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (dayRef.current === null) dayRef.current = day;
      // the UTC day rolled over while we watched — the board just closed.
      // give the server clock a few seconds to cross midnight too (so its
      // lazy close sees the finished day as "yesterday"), then refresh; a
      // second pass covers any clock skew, and is a cheap no-op if the
      // crown already landed.
      if (day !== dayRef.current && !crossedRef.current) {
        crossedRef.current = true;
        setTimeout(() => router.refresh(), 4000);
        setTimeout(() => router.refresh(), 15000);
      }
      const next = new Date(now);
      next.setUTCHours(24, 0, 0, 0);
      setLeft(fmt(next.getTime() - now.getTime()));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [router]);

  return (
    <span className={className ?? "font-pixel tabular-nums"}>
      {left || "…"}
    </span>
  );
}
