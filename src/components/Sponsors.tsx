"use client";

import { useEffect, useRef, useState } from "react";
import Favicon from "./Favicon";

export interface SponsorInfo {
  id: string;
  name: string;
  pitch: string;
  url: string;
  clicks: number;
  /** what the slot sold for, in cents */
  priceCents: number;
}

export interface SponsorData {
  sponsors: SponsorInfo[];
  slotsLeft: number;
  nextPriceCents: number;
}

// 5 on each rail; empty slots open the advertise modal with the details
const SLOTS_LEFT_RAIL = 5;
const SLOTS_RIGHT_RAIL = 5;
const SLOTS_TOTAL = SLOTS_LEFT_RAIL + SLOTS_RIGHT_RAIL;
// the checkout route accepts 120, but a 208px card shows about 52 characters
// at two lines and 78 at three — cap it in the field so nobody pays for copy
// the rail will only ellipsize
const PITCH_MAX = 60;

function faviconFor(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `/api/icon?kind=url&slug=${encodeURIComponent(host)}`;
  } catch {
    return "";
  }
}

// Newest purchase first. The API returns sponsors in the order they bought,
// and the ladder means the last buyer paid the most, so display order is
// reversed: the top slot is the one that costs the most to hold.
function newestFirst(data: SponsorData | null): SponsorInfo[] {
  return data ? [...data.sponsors].reverse() : [];
}

export function SponsorRail({
  side,
  data,
  onAdvertise,
}: {
  side: "left" | "right";
  data: SponsorData | null;
  onAdvertise: () => void;
}) {
  // the API hands these back oldest-first. Slot price climbs with every
  // sale, so left as-is the newest sponsor pays the most and lands in the
  // worst position — show them newest-first instead, so what you pay for
  // is the top of the rail
  const sponsors = newestFirst(data);
  const price = data ? Math.round(data.nextPriceCents / 100) : null;
  const slots: (SponsorInfo | null)[] = [];
  const railSize = side === "left" ? SLOTS_LEFT_RAIL : SLOTS_RIGHT_RAIL;
  for (let i = 0; i < railSize; i++) {
    // row-major across the two rails: sponsors fill left→right, then the
    // next row down — row i holds sponsors 2i (left) and 2i+1 (right)
    const globalIndex = side === "left" ? i * 2 : i * 2 + 1;
    slots.push(sponsors[globalIndex] ?? null);
  }

  return (
    // the wrapper (SponsorRails) is fixed top-40→bottom-4, so h-full here is
    // exactly the viewport slice the rail owns — cards divide it evenly
    <aside className="flex h-full flex-col gap-3">
      {/* every slot flexes to the same height, filled or not, so the two
          rails stay aligned no matter how many sponsors have paid and all 5
          always fit on screen; max-h keeps them card-shaped on tall monitors
          instead of stretching into billboards */}
      {slots.map((s, i) =>
        s ? (
          <a
            key={`${s.id}-${i}`}
            href={`/out/sponsor/${s.id}`}
            target="_blank"
            rel="noopener"
            className="pixel-card relative p-2.5 text-center w-52 flex-1 min-h-0 max-h-48 flex flex-col items-center justify-center overflow-hidden hover:bg-sand/40"
          >
            {/* corner badges: absolute, so neither costs the pitch a line.
                what they paid on the left, what it bought on the right */}
            {s.priceCents > 0 && (
              <span
                className="absolute top-1 left-1.5 font-pixel text-[7px] text-orange-deep"
                title="what this slot sold for"
              >
                paid ${Math.round(s.priceCents / 100)}
              </span>
            )}
            {s.clicks > 0 && (
              <span
                className="absolute top-1 right-1.5 font-pixel text-[7px] text-muted"
                title="clicks counted since Aug 22, 2026 — earlier ones weren't tracked"
              >
                {s.clicks} {s.clicks === 1 ? "click" : "clicks"}
              </span>
            )}
            <span className="icon-frame w-9 h-9 block mx-auto mb-1.5 shrink-0">
              <Favicon src={faviconFor(s.url)} />
            </span>
            <p className="font-pixel text-[10px] leading-relaxed truncate w-full">
              {s.name}
            </p>
            {/* VT323 draws taller than leading-tight reserves, so a clamped
                line got sliced through the middle of its glyphs — snug is
                the tightest leading the font survives. The clamp then
                follows the card: the rail divides the viewport by five, so
                how many lines fit depends on how tall the window is */}
            <p
              className="text-lg leading-snug text-muted mt-1 line-clamp-2
                         [@media(max-height:830px)]:line-clamp-1
                         [@media(min-height:1000px)]:line-clamp-3"
            >
              {s.pitch}
            </p>
          </a>
        ) : (
          <button
            key={`empty-${i}`}
            onClick={onAdvertise}
            className="border-[3px] border-dashed border-ink/40 p-4 text-center w-52 flex-1 min-h-0 max-h-48 flex flex-col items-center justify-center gap-2 overflow-hidden hover:border-orange-deep hover:text-orange-deep"
            title="Advertise on flappybid"
          >
            <span className="font-pixel text-sm leading-none">+</span>
            {price !== null && (
              <span className="font-pixel text-xs">${price}</span>
            )}
            <span className="font-pixel text-[8px] uppercase">Available</span>
          </button>
        )
      )}
    </aside>
  );
}

// Mobile/tablet replacement for the rails: a swipeable strip under the
// champion card. Ends with the Advertise card so the pitch is always there.
export function SponsorCarousel({
  data,
  onAdvertise,
}: {
  data: SponsorData | null;
  onAdvertise: () => void;
}) {
  // same ordering as the rails — newest purchase leads
  const sponsors = newestFirst(data);
  const stripRef = useRef<HTMLDivElement>(null);
  // autoplay yields to the user: any touch/drag pauses it for a grace period
  const pausedUntil = useRef(0);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || sponsors.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const holdOff = () => {
      pausedUntil.current = Date.now() + 6000;
    };
    strip.addEventListener("touchstart", holdOff, { passive: true });
    strip.addEventListener("pointerdown", holdOff);
    strip.addEventListener("wheel", holdOff, { passive: true });

    const tick = window.setInterval(() => {
      if (Date.now() < pausedUntil.current) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      const atEnd =
        strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4;
      if (atEnd) {
        strip.scrollTo({ left: 0, behavior: "smooth" });
        return;
      }
      // step one card forward; all cards share a width, so the stride is
      // the distance between the first two, and snap-mandatory keeps the
      // landing position aligned
      const cards = strip.querySelectorAll<HTMLElement>("[data-snap-card]");
      const step =
        cards.length > 1
          ? cards[1].getBoundingClientRect().left -
            cards[0].getBoundingClientRect().left
          : strip.clientWidth;
      strip.scrollBy({ left: step, behavior: "smooth" });
    }, 3000);

    return () => {
      window.clearInterval(tick);
      strip.removeEventListener("touchstart", holdOff);
      strip.removeEventListener("pointerdown", holdOff);
      strip.removeEventListener("wheel", holdOff);
    };
  }, [sponsors.length]);

  // no sponsors yet: a lone card in a scroll strip looks like a misplaced
  // box, and the wall banner above already carries the same pitch with
  // better copy — so on mobile there is nothing to show here
  if (sponsors.length === 0) return null;

  return (
    <div
      ref={stripRef}
      className="xl:hidden mb-8 -mx-4 px-4 overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex gap-3 w-max pb-2">
        {sponsors.map((s) => (
          <a
            key={s.id}
            data-snap-card
            href={`/out/sponsor/${s.id}`}
            target="_blank"
            rel="noopener"
            className="pixel-card relative p-3 w-40 shrink-0 snap-start text-center hover:bg-sand/40"
          >
            {s.priceCents > 0 && (
              <span className="absolute top-1 left-1.5 font-pixel text-[7px] text-orange-deep">
                paid ${Math.round(s.priceCents / 100)}
              </span>
            )}
            {s.clicks > 0 && (
              <span
                className="absolute top-1 right-1.5 font-pixel text-[7px] text-muted"
                title="clicks counted since Aug 22, 2026 — earlier ones weren't tracked"
              >
                {s.clicks} {s.clicks === 1 ? "click" : "clicks"}
              </span>
            )}
            <span className="icon-frame w-8 h-8 block mx-auto mb-2">
              <Favicon src={faviconFor(s.url)} />
            </span>
            <p className="font-pixel text-[8px] leading-relaxed truncate">
              {s.name}
            </p>
            <p className="text-sm leading-snug text-muted mt-1 line-clamp-2">
              {s.pitch}
            </p>
          </a>
        ))}
        <button
          data-snap-card
          onClick={onAdvertise}
          className="pixel-panel p-3 w-40 shrink-0 snap-start text-center hover:brightness-105"
        >
          <p className="font-pixel text-[9px] uppercase">Advertise</p>
          <p className="text-base mt-1.5">
            {data
              ? `$${Math.round(data.nextPriceCents / 100)} · ${
                  data.slotsLeft > 0
                    ? `${data.slotsLeft}/${SLOTS_TOTAL} left`
                    : "buy out the oldest"
                }`
              : "sponsor slot"}
          </p>
          <p className="text-sm text-muted mt-1">your card here</p>
        </button>
      </div>
    </div>
  );
}

export function AdvertiseModal({
  data,
  onClose,
}: {
  data: SponsorData | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [pitch, setPitch] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const price = data ? Math.round(data.nextPriceCents / 100) : 10;
  const slotsLeft = data?.slotsLeft ?? SLOTS_TOTAL;

  const pay = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/sponsors/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pitch, url }),
      });
      const out = await res.json();
      if (!res.ok) {
        setError(out.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      window.location.href = out.url;
    } catch {
      setError("Network error — try again.");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      onClick={onClose}
    >
      <div
        className="pixel-panel w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-pixel text-sm leading-relaxed">
            Advertise on flappybid
          </h2>
          <button
            onClick={onClose}
            className="font-pixel text-xs hover:text-orange-deep"
            aria-label="Close"
          >
            X
          </button>
        </div>
        <p className="text-lg mt-3">
          {SLOTS_TOTAL} sponsor slots beside a board people mash buttons on all
          day. One payment — yours until a full board buys out your slot.
        </p>

        <div className="grid grid-cols-3 gap-3 my-5">
          <div className="pixel-card p-3 text-center">
            <p className="font-pixel text-xs">${price}</p>
            <p className="text-base leading-tight text-muted mt-1">
              one-time, right now
            </p>
          </div>
          <div className="pixel-card p-3 text-center">
            <p className="font-pixel text-xs">
              {slotsLeft > 0 ? "+$10" : "×1.5"}
            </p>
            <p className="text-base leading-tight text-muted mt-1">
              {slotsLeft > 0 ? "each slot sold" : "each buyout"}
            </p>
          </div>
          <div className="pixel-card bg-gold p-3 text-center">
            <p className="font-pixel text-xs">{slotsLeft}/{SLOTS_TOTAL}</p>
            <p className="text-base leading-tight text-muted mt-1">slots left</p>
          </div>
        </div>

        <p className="text-lg mb-4">
          Your card goes straight to the top of the rail and slides down a
          slot each time someone new buys in. Get in early: the price only
          goes up as slots sell. Once all {SLOTS_TOTAL} are sold, a new
          payment buys out the card that has been up the longest — the one
          at the bottom — at 1.5× the last price paid. Only that one is ever
          up for grabs.
        </p>

        <div className="flex flex-col gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Company name"
            className="border-[3px] border-ink bg-paper px-4 py-2.5 text-xl outline-none focus:border-orange-deep"
          />
          <div>
            <input
              value={pitch}
              onChange={(e) => setPitch(e.target.value.slice(0, PITCH_MAX))}
              maxLength={PITCH_MAX}
              placeholder="One-line pitch (shown on your card)"
              className="w-full border-[3px] border-ink bg-paper px-4 py-2.5 text-xl outline-none focus:border-orange-deep"
            />
            <p className="mt-1.5 text-base text-muted text-right">
              {PITCH_MAX - pitch.length} left · longer pitches get cut off on
              the card
            </p>
          </div>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Website (e.g. myapp.com) — we use its favicon"
            className="border-[3px] border-ink bg-paper px-4 py-2.5 text-xl outline-none focus:border-orange-deep"
          />
          {error && <p className="text-lg text-red">{error}</p>}
          <button
            onClick={pay}
            disabled={busy}
            className="pixel-btn bg-orange text-white text-[10px] py-3"
          >
            {busy
              ? "Redirecting…"
              : slotsLeft <= 0
                ? `Pay $${price} — buy out the oldest slot`
                : `Pay $${price} with Stripe`}
          </button>
          <p className="text-base text-center">
            Your slot goes live the moment your payment lands. Questions? DM{" "}
            <a
              href="https://x.com/ahmadafterhours"
              target="_blank"
              rel="noopener"
              className="underline hover:text-orange-deep"
            >
              @ahmadafterhours
            </a>{" "}
            or{" "}
            <a
              href="https://x.com/omarships"
              target="_blank"
              rel="noopener"
              className="underline hover:text-orange-deep"
            >
              @omarships
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
