"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import GameModal, { type PlayableProduct } from "./GameModal";
import {
  SponsorCarousel,
  AdvertiseModal,
  type SponsorData,
} from "./Sponsors";
import PixelBird from "./PixelBird";
import LogoBidModal from "./LogoBidModal";
import { LOGO_PRICE_CENTS } from "@/lib/logo";
import { currentFitInfo, FIT_EVENT } from "@/game/wardrobe";
import { utcDay } from "@/lib/day";
import XBoostButton from "./XBoostButton";
import WardrobeModal from "./WardrobeModal";
import Favicon from "./Favicon";
import { productIcon } from "@/lib/normalize";
import type { Board } from "@/lib/board";

export default function Home({ initialBoard }: { initialBoard: Board }) {
  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [sponsorData, setSponsorData] = useState<SponsorData | null>(null);
  const [playing, setPlaying] = useState<PlayableProduct | null>(null);
  const [advertising, setAdvertising] = useState(false);
  const [biddingLogo, setBiddingLogo] = useState(false);
  const [dressing, setDressing] = useState(false);
  const [notice, setNotice] = useState("");
  // products this browser entered this session — only these rows get a
  // "play again" shortcut; everyone else re-enters via the hero form
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());
  // lives here (not in Leaderboard) so the poll refetches at the same depth
  // the user has paged to — otherwise every refresh would truncate back to 100
  const [visibleCount, setVisibleCount] = useState(LEADERBOARD_PAGE_SIZE);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("fb_played");
      if (raw) setPlayedIds(new Set(JSON.parse(raw)));
    } catch {
      // sessionStorage unavailable — buttons just stay hidden
    }
  }, []);

  const play = useCallback((p: PlayableProduct) => {
    setPlayedIds((prev) => {
      if (prev.has(p.id)) return prev;
      const next = new Set(prev).add(p.id);
      try {
        sessionStorage.setItem("fb_played", JSON.stringify([...next]));
      } catch {
        // non-persistent is fine
      }
      return next;
    });
    setPlaying(p);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/leaderboard?limit=${Math.max(100, visibleCount)}`
      );
      if (res.ok) setBoard(await res.json());
    } catch {
      // keep last known board
    }
  }, [visibleCount]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    fetch("/api/sponsors")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSponsorData)
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get("sponsored")) {
      setNotice("Payment received — your sponsor slot is live on the rails!");
    }
    if (params.get("logo")) {
      setNotice("Payment received — your logo is in review. We'll be in touch.");
    }
  }, []);

  return (
    // the sponsor rails moved to the root layout (SponsorRails) so every
    // tab carries them — the board keeps only its middle column
    <div className="w-full px-4 py-6">
      <div className="max-w-2xl w-full mx-auto">
        {notice && (
          <div className="mb-6 pixel-panel px-4 py-3 text-lg text-center">
            {notice}
          </div>
        )}

        <Hero
          onPlay={play}
          onNotice={setNotice}
          onWardrobe={() => setDressing(true)}
          totalRuns={board?.totalRuns ?? null}
        />

        <div className="mt-5 mb-6">
          <LogoBanner onBid={() => setBiddingLogo(true)} />
        </div>

        <SponsorCarousel
          data={sponsorData}
          onAdvertise={() => setAdvertising(true)}
        />

        <Leaderboard
          board={board}
          onPlay={play}
          playedIds={playedIds}
          visibleCount={visibleCount}
          onMore={() => setVisibleCount((v) => v + LEADERBOARD_PAGE_SIZE)}
        />
      </div>

      {playing && (
        <GameModal
          product={playing}
          onClose={() => setPlaying(null)}
          onScored={refresh}
          onBuyLogo={() => {
            // hand off rather than stack modals — both sit at z-50
            setPlaying(null);
            setBiddingLogo(true);
          }}
        />
      )}
      {advertising && (
        <AdvertiseModal
          data={sponsorData}
          onClose={() => setAdvertising(false)}
        />
      )}
      {biddingLogo && <LogoBidModal onClose={() => setBiddingLogo(false)} />}
      {dressing && <WardrobeModal onClose={() => setDressing(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------- hero

// Anonymous presence: a uuid per browser (localStorage), heartbeat every 30s
// while the tab is visible — hidden tabs go quiet and fall out of the online
// window, so "online" means someone actually looking at the page. The API
// answers with total visitors ever and how many pinged recently.
function usePresence(): { online: number; total: number } | null {
  const [stats, setStats] = useState<{ online: number; total: number } | null>(
    null
  );
  useEffect(() => {
    let vid = "";
    try {
      vid = localStorage.getItem("fb_vid") ?? "";
      if (!vid) {
        vid = crypto.randomUUID();
        localStorage.setItem("fb_vid", vid);
      }
    } catch {
      vid = crypto.randomUUID();
    }
    let stopped = false;
    const ping = async () => {
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: vid }),
        });
        const d = await res.json();
        if (!stopped && typeof d?.online === "number") setStats(d);
      } catch {
        // keep last known stats
      }
    };
    // first ping runs even if the tab opened in the background: it registers
    // the visit and fetches the counters for display
    ping();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") ping();
    }, 30_000);
    // the interval skips hidden ticks, so re-ping the moment we're back
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return stats;
}

// One cell of the hero stat strip: big pixel number over a muted label.
function HeroStat({
  value,
  label,
  labelWide,
  live,
}: {
  value: number | null;
  label: string;
  labelWide?: string;
  live?: boolean;
}) {
  return (
    <div className="px-2.5 sm:px-5 py-1.5 text-center flex-1 sm:flex-none">
      <p className="font-pixel text-[10px] sm:text-sm flex items-center justify-center gap-1.5">
        {live && (
          <span
            className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-pipe animate-pulse inline-block shrink-0"
            aria-hidden
          />
        )}
        {value === null ? "…" : value.toLocaleString()}
      </p>
      <p className="font-pixel text-[6px] sm:text-[8px] uppercase text-muted mt-1 whitespace-nowrap">
        <span className={labelWide ? "sm:hidden" : ""}>{label}</span>
        {labelWide && <span className="hidden sm:inline">{labelWide}</span>}
      </p>
    </div>
  );
}

function Hero({
  onPlay,
  onNotice,
  onWardrobe,
  totalRuns,
}: {
  onPlay: (p: PlayableProduct) => void;
  onNotice: (msg: string) => void;
  onWardrobe: () => void;
  totalRuns: number | null;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const presence = usePresence();

  // SSR shows the shared daily fit; the visitor's saved fit swaps in on
  // mount and whenever the wardrobe changes it. Only the desktop wardrobe
  // chip reads this, to flag a fit the visitor has not seen yet.
  const [fitInfo, setFitInfo] = useState<{
    label: string;
    custom: boolean;
  } | null>(null);
  useEffect(() => {
    const update = () => setFitInfo(currentFitInfo(utcDay()));
    update();
    window.addEventListener(FIT_EVENT, update);
    return () => window.removeEventListener(FIT_EVENT, update);
  }, []);

  const enter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not enter.");
        return;
      }
      if (data.retired) {
        onNotice(
          `${data.product.name} won ${data.wonOn} and retired undefeated — champions never compete again.`
        );
        return;
      }
      onPlay(data.product);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="text-center mb-5">
      {/* back to the live 2x2: stats and the wardrobe on top, the vote and
          the Agently credit under them, every box stretched to its column
          and its row so the block reads as one unit. Phones drop to a
          single column, where the wardrobe hides and the vote comes second */}
      <div className="mb-4 grid grid-cols-1 sm:grid-cols-[auto_auto] items-stretch justify-center justify-items-stretch gap-2.5">
        {/* number over label, the way the live bar does it: three one-line
            segments would need 405px of a 343px bar once "runs" appears,
            stacking fits them in 282 */}
        <div className="pixel-card flex items-stretch justify-center
                        divide-x-[3px] divide-ink">
          <HeroStat value={presence ? presence.total : null} label="visitors" />
          <HeroStat value={presence ? presence.online : null} label="online" live />
          {/* all-time run count, counted server-side */}
          {totalRuns !== null && totalRuns > 0 && (
            <HeroStat value={totalRuns} label="runs" labelWide="total runs" />
          )}
        </div>

        <button
          onClick={onWardrobe}
          className="hidden sm:inline-flex items-center justify-center gap-2
                     bg-paper border-[3px] border-ink px-2.5 py-1.5
                     shadow-[3px_3px_0_var(--color-ink)] font-pixel text-[9px]
                     uppercase tracking-wide whitespace-nowrap
                     hover:translate-y-[2px] hover:shadow-[1px_1px_0_var(--color-ink)]
                     transition-transform"
        >
          👕 dress your bird
          {fitInfo && !fitInfo.custom && (
            <span className="bg-gold border-2 border-ink px-1.5 py-0.5 text-[7px] uppercase animate-pulse">
              new
            </span>
          )}
        </button>

        {/* the button styles itself — stretch it to the cell from outside */}
        <div className="flex [&>button]:flex-1 [&>button]:justify-center
                        [&>button]:text-[8px] [&>button]:tracking-wide [&>button]:px-2.5">
          <XBoostButton />
        </div>

        <a
          href="https://agently.dev?utm_source=flappybid&utm_medium=hero"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center justify-center gap-2 bg-paper border-[3px] border-ink
                     px-2.5 sm:px-3 py-1.5 shadow-[3px_3px_0_var(--color-ink)]
                     font-pixel text-[7px] sm:text-[9px] uppercase tracking-wide
                     whitespace-nowrap hover:translate-y-[2px]
                     hover:shadow-[1px_1px_0_var(--color-ink)] transition-transform"
        >
          <span className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 border-2 border-ink overflow-hidden">
            <Favicon src={productIcon("url", "agently.dev", 64)} />
          </span>
          <span className="text-muted">Built with</span>
          <span className="text-ink">Agently</span>
        </a>
      </div>

      {/* the bird flies beside the headline and still opens the wardrobe;
          hats overflow its box upward (tallest is 7 sprite rows ~= 24px
          here, plus the 4px float) so keep the top margin clear */}
      <h1 className="font-pixel text-xl sm:text-2xl leading-[1.7] text-white text-outline flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <button
          onClick={onWardrobe}
          className="cursor-pointer transition-transform hover:scale-110"
          title="Dress your bird"
          aria-label="Dress your bird"
        >
          <PixelBird className="w-14 h-10 animate-float" />
        </button>
        <span>
          Claim #1 with <span className="text-gold">pure skill</span>
        </span>
      </h1>
      {/* the last clause is desktop-only: on a 375px screen it is the
          difference between a three- and a four-line paragraph, and the
          fourth line pushes the ad block off the fold */}
      <p className="mt-2 max-w-2xl mx-auto text-lg">
        The leaderboard money can&apos;t buy. Play Flappy Bird for your
        product — unlimited runs, best score today is your rank.
        <span className="hidden sm:inline">
          {" "}
          Win the day and you own this page tomorrow.
        </span>
      </p>

      <form onSubmit={enter} className="mt-4 flex gap-3 max-w-lg mx-auto">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Your product URL or @handle"
          className="flex-1 min-w-0 border-[3px] border-ink bg-paper px-4 py-3 text-xl outline-none focus:border-orange-deep shadow-[4px_4px_0_rgba(0,0,0,0.28)]"
        />
        <button
          type="submit"
          disabled={busy}
          className="pixel-btn bg-orange text-white text-xs px-6 py-3 shrink-0"
        >
          {busy ? "…" : "Play"}
        </button>
      </form>
      {error && <p className="text-lg text-red mt-3">{error}</p>}
      <p className="text-lg mt-3">
        Already listed? Enter it again to beat its best. Board locks in{" "}
        <CountdownInline />.
      </p>
    </section>
  );
}

function CountdownInline() {
  const [left, setLeft] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(24, 0, 0, 0);
      const ms = next.getTime() - now.getTime();
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setLeft(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      );
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-pixel text-[11px] align-middle">{left || "…"}</span>
  );
}

// ------------------------------------------------------------ leaderboard

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const LEADERBOARD_PAGE_SIZE = 50;
// mirrors the ?limit= clamp in api/leaderboard — past this the server won't
// return more rows, so the button has to stop offering them
const LEADERBOARD_HARD_CAP = 5000;

// The wall's numbers, shared by the strip on the page and the offer on the
// run screen so the two can never drift.
export function wallStats(data: SponsorData | null) {
  const live = data?.sponsors ?? [];
  return {
    price: data ? Math.round(data.nextPriceCents / 100) : 10,
    left: data?.slotsLeft ?? 10,
    clicks: live.reduce((n, s) => n + (s.clicks ?? 0), 0),
    // what the wall has actually taken. Summing the ladder instead would
    // read right today and drift the first time a slot is bought out
    spent: Math.round(
      live.reduce((n, s) => n + (s.priceCents ?? 0), 0) / 100
    ),
  };
}

// The banner that used to sell the sponsor wall now sells the logo itself:
// one flat price to put your brand where the flappy bird sits. The sponsor
// wall still lives on in the carousel and the run-screen offer.
function LogoBanner({ onBid }: { onBid: () => void }) {
  const price = Math.round(LOGO_PRICE_CENTS / 100);
  // the tile flips from the flappy bird to a "YOUR LOGO" slot and back — the
  // whole pitch in one glance: this spot is the bird's, and it could be yours
  const [showSlot, setShowSlot] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setShowSlot((v) => !v), 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <button
      onClick={onBid}
      className="group relative w-full overflow-hidden bg-orange text-white border-[3px] border-ink
                 px-3 sm:px-3.5 py-2.5 text-left
                 shadow-[3px_3px_0_rgba(0,0,0,0.3)]
                 hover:brightness-105 active:translate-y-[2px]"
    >
      {/* glossy sweep — the one smooth accent, drawing the eye across the strip */}
      <span
        className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/5 bg-white/25 blur-[1px] logo-shine"
        aria-hidden
      />

      <div className="relative flex items-center justify-between gap-3 sm:gap-4">
        {/* flip tile: front = the bird, back = an empty "YOUR LOGO" slot */}
        <span
          className="shrink-0 w-11 h-11 sm:w-14 sm:h-14 [perspective:520px]"
          aria-hidden
        >
          <span
            className={`relative block w-full h-full transition-transform duration-500 ease-out [transform-style:preserve-3d] ${
              showSlot ? "[transform:rotateY(180deg)]" : ""
            }`}
          >
            <span
              className="absolute inset-0 grid place-items-center bg-paper border-[3px] border-ink
                         shadow-[0_2px_0_var(--color-ink)] [backface-visibility:hidden]"
            >
              <PixelBird className="w-7 h-5 sm:w-9 sm:h-6 animate-float" />
            </span>
            <span
              className="absolute inset-0 grid place-items-center bg-ink text-gold
                         border-[3px] border-gold shadow-[0_2px_0_var(--color-ink)]
                         [backface-visibility:hidden] [transform:rotateY(180deg)]"
            >
              <span className="font-pixel text-[6px] sm:text-[8px] leading-[1.4] text-center">
                YOUR
                <br />
                LOGO
              </span>
            </span>
          </span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="block font-pixel text-[9px] sm:text-[12px] leading-snug">
            Where the bird flies?{" "}
            <span className="text-gold">Your logo.</span>
          </span>
          <span className="block mt-1 text-sm leading-snug text-white/90">
            One brand takes the throne · reviewed before it flies
          </span>
        </span>

        <span
          className="font-pixel text-[8px] sm:text-[11px] bg-paper text-ink border-[3px] border-ink
                     px-2 py-1 shrink-0 shadow-[0_2px_0_var(--color-ink)]
                     inline-flex items-center gap-1"
        >
          ${price.toLocaleString()}
        </span>
      </div>
    </button>
  );
}

function TierDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1" aria-hidden>
      <span className="flex-1 border-t-[3px] border-dashed border-ink/40" />
      <span className="font-pixel text-[8px] uppercase text-muted">
        {label}
      </span>
      <span className="flex-1 border-t-[3px] border-dashed border-ink/40" />
    </div>
  );
}

function Leaderboard({
  board,
  onPlay,
  playedIds,
  visibleCount,
  onMore,
}: {
  board: Board | null;
  onPlay: (p: PlayableProduct) => void;
  playedIds: Set<string>;
  visibleCount: number;
  onMore: () => void;
}) {
  if (!board) {
    return (
      <div className="text-center py-16 text-xl">loading today&apos;s board…</div>
    );
  }
  if (board.entries.length === 0) {
    return (
      <div className="text-center py-16 border-[3px] border-dashed border-ink/50">
        <p className="font-pixel text-xs leading-relaxed">
          Nobody has scored today.
        </p>
        <p className="text-xl mt-3">
          First run on the board takes #1. That could be you, right now.
        </p>
      </div>
    );
  }

  // totalPlayers is the exact count of scorers today, so this stays positive
  // past the fetched slice — the button keeps paging until the day runs dry
  // (or the server's hard cap, whichever comes first)
  const hidden =
    Math.min(
      Math.max(board.entries.length, board.totalPlayers),
      LEADERBOARD_HARD_CAP
    ) - visibleCount;

  return (
    <section className="flex flex-col gap-3">
      <p className="text-center font-pixel text-[8px] uppercase text-muted">
        {board.totalPlayers.toLocaleString()} product
        {board.totalPlayers === 1 ? "" : "s"} flying today
      </p>
      {board.entries.slice(0, visibleCount).map((e, i, visible) => {
        // tier cutoffs — a divider under ranks 3/10/25 when more rows follow
        const tier =
          i < visible.length - 1 &&
          (e.rank === 3 || e.rank === 10 || e.rank === 25)
            ? `top ${e.rank}`
            : null;
        const isFirst = e.rank === 1;
        const medal =
          e.rank === 2
            ? { emoji: "🥈", label: "2nd place", chip: "bg-silver" }
            : e.rank === 3
              ? { emoji: "🥉", label: "3rd place", chip: "bg-bronze text-white" }
              : null;

        const playAgain = playedIds.has(e.id) && (
          <button
            onClick={() =>
              onPlay({ id: e.id, slug: e.slug, name: e.name, kind: e.kind })
            }
            className="pixel-btn bg-paper shrink-0 font-pixel text-[7px] uppercase
                       px-2.5 py-2.5 sm:px-3 sm:py-3"
            title={`Play again for ${e.name} — no need to re-enter it`}
            aria-label={`Play again for ${e.name}`}
          >
            <span className="sm:hidden">again</span>
            <span className="hidden sm:inline">play again</span>
          </button>
        );

        if (isFirst) {
          return (
            <div className="pixel-panel bg-gold overflow-hidden" key={e.id}>
              <div className="border-b-[3px] border-ink bg-orange px-3 py-1.5 text-center">
                <span className="font-pixel text-[8px] uppercase tracking-wider text-white">
                  👑 today&apos;s best 👑
                </span>
              </div>
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-4 px-3.5 sm:px-5 py-5">
                <div className="w-10 h-10 sm:w-12 sm:h-12 border-[3px] border-ink bg-orange text-white flex items-center justify-center text-xl sm:text-2xl shrink-0">
                  👑
                </div>
                <span className="icon-frame w-10 h-10 sm:w-12 sm:h-12 block border-[3px] shrink-0">
                  <Favicon src={productIcon(e.kind, e.slug)} alt={e.name} />
                </span>
                <div className="min-w-0 flex-1 basis-full sm:basis-auto order-last sm:order-none">
                  <a
                    href={`/out/${encodeURIComponent(e.slug)}`}
                    target="_blank"
                    rel="noopener"
                    className="font-pixel text-xs sm:text-sm break-words sm:break-normal sm:whitespace-nowrap sm:overflow-hidden sm:text-ellipsis hover:text-orange-deep block leading-relaxed"
                  >
                    {e.name}
                  </a>
                  <p className="text-lg mt-1.5">
                    {e.runs} run{e.runs === 1 ? "" : "s"} · best{" "}
                    {timeAgo(e.bestAt)}
                    {e.clicks > 0 &&
                      ` · ${e.clicks.toLocaleString()} click${e.clicks === 1 ? "" : "s"}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-pixel text-2xl sm:text-3xl text-white text-outline">
                    {e.score}
                  </p>
                </div>
                {playAgain}
              </div>
            </div>
          );
        }

        return (
          <Fragment key={e.id}>
          <div
            className={
              medal
                ? "flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-4 pixel-card px-3 sm:px-4 py-3"
                : "flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-4 pixel-card px-3 sm:px-4 py-2.5"
            }
          >
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
              <div className="flex items-center gap-2 min-w-0">
                <a
                  href={`/out/${encodeURIComponent(e.slug)}`}
                  target="_blank"
                  rel="noopener"
                  className="font-pixel text-[10px] sm:text-[11px] break-words sm:break-normal sm:whitespace-nowrap sm:overflow-hidden sm:text-ellipsis hover:text-orange-deep block leading-relaxed"
                >
                  {e.name}
                </a>
                {medal && (
                  <span
                    className={`font-pixel text-[7px] uppercase px-1.5 py-1 border-2 border-ink shrink-0 hidden sm:inline-block ${medal.chip}`}
                  >
                    {medal.label}
                  </span>
                )}
              </div>
              <p className="text-base mt-1">
                {e.runs} run{e.runs === 1 ? "" : "s"} · best {timeAgo(e.bestAt)}
                {e.clicks > 0 &&
                  ` · ${e.clicks.toLocaleString()} click${e.clicks === 1 ? "" : "s"}`}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-pixel text-base sm:text-lg">{e.score}</p>
            </div>
            {playAgain}
          </div>
          {tier && <TierDivider label={tier} />}
          </Fragment>
        );
      })}
      {hidden > 0 && (
        <button
          onClick={onMore}
          className="pixel-btn bg-paper font-pixel text-[10px] px-6 py-3 mx-auto mt-2"
        >
          load {Math.min(hidden, LEADERBOARD_PAGE_SIZE)} more
        </button>
      )}
    </section>
  );
}
