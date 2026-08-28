"use client";

import { useEffect, useSyncExternalStore } from "react";
import { utcDay } from "@/lib/day";

// Hero badge: share flappybid on X, fly with 2x points for the day. Same
// honor-system grant as the end-game "share = 2x" button — X can't tell us
// who really posted, so the click IS the grant (see /api/boost/share). This
// mirrors the end-game button's localStorage key (fb_x_boost) so a boost
// claimed here shows as active there and vice-versa; the server tracks the
// real grant by ip hash. Because /api/boost/share also runs the retroactive
// RPC, claiming here doubles any runs already scored today.

// claimed-state lives outside React: read on demand (SSR snapshot is always
// "not claimed", resolved right after hydration), re-read when claim() emits
let listeners: (() => void)[] = [];
function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
function claimedToday(): boolean {
  try {
    return localStorage.getItem("fb_x_boost") === utcDay();
  } catch {
    return false; // storage unavailable — the button stays in its default state
  }
}

// The hero has no product context (nobody's played yet), so this shares the
// site itself rather than a per-product flex card.
function shareOnX() {
  const url = window.location.origin;
  const text =
    "flying products on flappybid.lol — the leaderboard money can't buy. claim #1 with pure skill:";
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(
    text
  )}&url=${encodeURIComponent(url)}`;
  window.open(intent, "_blank", "noopener");
}

export default function XBoostButton() {
  const active = useSyncExternalStore(subscribe, claimedToday, () => false);

  // self-heal: a click that failed server-side (deploy race, network blip)
  // leaves localStorage claiming a boost the server never recorded — and the
  // grant is keyed by ip hash, which changes with the network. Re-firing the
  // idempotent grant on every load makes the server converge on the button's
  // claimed state.
  useEffect(() => {
    if (claimedToday()) {
      fetch("/api/boost/share", { method: "POST", keepalive: true }).catch(
        () => {}
      );
    }
  }, []);

  const claim = () => {
    shareOnX();
    // fire-and-forget: the X tab is already opening, the grant lands behind it
    fetch("/api/boost/share", { method: "POST", keepalive: true }).catch(
      () => {}
    );
    try {
      localStorage.setItem("fb_x_boost", utcDay());
    } catch {
      // the server-side grant still applies; only the button state is lost
    }
    listeners.forEach((l) => l());
  };

  return (
    <button
      type="button"
      onClick={claim}
      className={`inline-flex items-center gap-2.5 border-[3px] border-ink
                  px-3.5 py-2 shadow-[3px_3px_0_var(--color-ink)] font-pixel text-[9px]
                  uppercase tracking-widest hover:translate-y-[2px]
                  hover:shadow-[1px_1px_0_var(--color-ink)] transition-transform
                  ${active ? "bg-gold text-ink" : "bg-ink text-white"}`}
    >
      <span aria-hidden>𝕏</span>
      {active ? (
        <span>2x boost claimed — active today</span>
      ) : (
        <>
          <span>share on x</span>
          {/* same pulsing chip as the wardrobe's "new" badge */}
          <span className="bg-gold text-ink border-2 border-ink px-1.5 py-0.5 text-[7px] uppercase animate-pulse">
            click to claim 2x points
          </span>
        </>
      )}
    </button>
  );
}
