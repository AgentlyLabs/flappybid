"use client";

import { useCallback, useState } from "react";
import Favicon from "./Favicon";
import { productIcon } from "@/lib/normalize";
import { type GlobalBoard, type GlobalEntry } from "@/lib/globalBoard";

// The all-time board, paged 50 at a time. The first page is server-rendered
// (so crawlers and a JS-less load still see rank #1); every other page is
// fetched from /api/global-leaderboard on demand. The previous page stays on
// screen, dimmed, while the next one loads so the layout never collapses.
export default function GlobalLeaderboard({
  initial,
}: {
  initial: GlobalBoard;
}) {
  const [board, setBoard] = useState<GlobalBoard>(initial);
  const [loading, setLoading] = useState(false);

  const go = useCallback(
    async (page: number) => {
      const target = Math.min(Math.max(1, page), board.totalPages || 1);
      if (target === board.page || loading) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/global-leaderboard?page=${target}`);
        if (res.ok) {
          setBoard(await res.json());
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } catch {
        // network blip — keep the current page on screen
      } finally {
        setLoading(false);
      }
    },
    [board.page, board.totalPages, loading]
  );

  if (board.totalPlayers === 0) {
    return (
      <div className="text-center py-16 border-[3px] border-dashed border-ink/50">
        <p className="font-pixel text-xs leading-relaxed">
          Nobody has flown yet.
        </p>
        <p className="text-xl mt-3">
          The first product to post a score opens the all-time board.
        </p>
      </div>
    );
  }

  const first = (board.page - 1) * board.pageSize + 1;
  const last = first + board.entries.length - 1;

  return (
    <section className="flex flex-col gap-3">
      <p className="text-center font-pixel text-[8px] uppercase text-muted">
        {board.totalPlayers.toLocaleString()} product
        {board.totalPlayers === 1 ? "" : "s"} all-time · showing {first}–{last}
      </p>

      <div
        className={`flex flex-col gap-3 transition-opacity ${
          loading ? "opacity-50" : "opacity-100"
        }`}
      >
        {board.entries.map((e) => (
          <GlobalRow key={e.id} e={e} />
        ))}
      </div>

      {board.totalPages > 1 && (
        <Pager
          page={board.page}
          totalPages={board.totalPages}
          disabled={loading}
          onGo={go}
        />
      )}
    </section>
  );
}

// One all-time row: rank chip (medal for the global top 3), favicon, the
// product name linking out through /out for click tracking, its best-ever
// score on the right, and a runs·days meta line. Mirrors the daily board's
// pixel-card look so the two tabs read as one family.
function GlobalRow({ e }: { e: GlobalEntry }) {
  const medal =
    e.rank === 1
      ? { emoji: "🥇", chip: "bg-gold" }
      : e.rank === 2
        ? { emoji: "🥈", chip: "bg-silver" }
        : e.rank === 3
          ? { emoji: "🥉", chip: "bg-bronze text-white" }
          : null;

  return (
    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-4 pixel-card px-3 sm:px-4 py-2.5">
      <div
        className={
          medal
            ? `w-9 h-9 border-[3px] border-ink ${medal.chip} flex items-center justify-center text-base shrink-0`
            : "w-9 h-9 border-[3px] border-ink bg-sand flex items-center justify-center font-pixel text-[10px] shrink-0"
        }
      >
        {medal ? medal.emoji : e.rank}
      </div>
      <span className="icon-frame w-9 h-9 block">
        <Favicon src={productIcon(e.kind, e.slug)} alt={e.name} />
      </span>
      <div className="min-w-0 flex-1 basis-full sm:basis-auto order-last sm:order-none">
        <a
          href={`/out/${encodeURIComponent(e.slug)}`}
          target="_blank"
          rel="noopener"
          className="font-pixel text-[10px] sm:text-[11px] break-words sm:break-normal sm:whitespace-nowrap sm:overflow-hidden sm:text-ellipsis hover:text-orange-deep block leading-relaxed"
        >
          {e.name}
        </a>
        <p className="text-base mt-1">
          {e.totalRuns.toLocaleString()} run{e.totalRuns === 1 ? "" : "s"} ·{" "}
          {e.daysPlayed.toLocaleString()} day{e.daysPlayed === 1 ? "" : "s"}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="font-pixel text-base sm:text-lg">{e.score}</p>
        <p className="font-pixel text-[6px] uppercase text-muted mt-1">best</p>
      </div>
    </div>
  );
}

// Prev / Next around a compact window of page numbers. The window always keeps
// first and last reachable, with an ellipsis when there's a gap — so 1 200
// pages deep is still one tap from either end.
function Pager({
  page,
  totalPages,
  disabled,
  onGo,
}: {
  page: number;
  totalPages: number;
  disabled: boolean;
  onGo: (page: number) => void;
}) {
  const pages = pageWindow(page, totalPages);
  return (
    <nav
      className="flex items-center justify-center flex-wrap gap-1.5 mt-3"
      aria-label="Leaderboard pages"
    >
      <button
        onClick={() => onGo(page - 1)}
        disabled={disabled || page <= 1}
        className="pixel-btn bg-paper font-pixel text-[8px] uppercase px-3 py-2.5 disabled:opacity-40"
      >
        prev
      </button>
      {pages.map((p, i) =>
        p === "…" ? (
          <span
            key={`gap-${i}`}
            className="font-pixel text-[8px] text-muted px-1 select-none"
            aria-hidden
          >
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onGo(p)}
            disabled={disabled}
            aria-current={p === page ? "page" : undefined}
            className={`w-9 h-9 border-[3px] border-ink font-pixel text-[9px] shrink-0 disabled:opacity-40 ${
              p === page ? "bg-orange text-white" : "bg-paper hover:bg-sand"
            }`}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onGo(page + 1)}
        disabled={disabled || page >= totalPages}
        className="pixel-btn bg-paper font-pixel text-[8px] uppercase px-3 py-2.5 disabled:opacity-40"
      >
        next
      </button>
    </nav>
  );
}

// A short, gap-collapsed run of page numbers centered on the current page:
// always 1 and totalPages, the two neighbours of the current page, and "…"
// wherever a stretch is skipped.
function pageWindow(page: number, total: number): (number | "…")[] {
  const keep = new Set<number>([1, total, page, page - 1, page + 1]);
  const nums = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}
