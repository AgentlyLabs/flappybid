"use client";

import { useEffect, useSyncExternalStore } from "react";
import { utcDay } from "@/lib/day";
import { PH_URL } from "@/lib/boost";

// Hero badge: vote for us on Product Hunt, fly with 2x points for the day.
// The click IS the grant (see /api/boost — PH can't tell us who really
// voted); localStorage only remembers it so the button can show its active
// state, the server tracks the real grant by ip hash.

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
    return localStorage.getItem("fb_ph_boost") === utcDay();
  } catch {
    return false; // storage unavailable — the button stays in its default state
  }
}

export default function PHBoostButton() {
  const active = useSyncExternalStore(subscribe, claimedToday, () => false);

  // self-heal: a click that failed server-side (deploy race, network blip)
  // leaves localStorage claiming a boost the server never recorded — and the
  // grant is keyed by ip hash, which changes with the network. Re-firing the
  // idempotent grant on every load makes the server converge on the button's
  // claimed state; this happened for real on launch day.
  useEffect(() => {
    if (claimedToday()) {
      fetch("/api/boost", { method: "POST", keepalive: true }).catch(() => {});
    }
  }, []);

  const claim = () => {
    // fire-and-forget: the PH tab is already opening, the grant lands behind it
    fetch("/api/boost", { method: "POST", keepalive: true }).catch(() => {});
    try {
      localStorage.setItem("fb_ph_boost", utcDay());
    } catch {
      // the server-side grant still applies; only the button state is lost
    }
    listeners.forEach((l) => l());
  };

  return (
    <a
      href={PH_URL}
      target="_blank"
      rel="noopener"
      onClick={claim}
      className={`inline-flex items-center gap-2.5 border-[3px] border-ink
                  px-3.5 py-2 shadow-[3px_3px_0_var(--color-ink)] font-pixel text-[9px]
                  uppercase tracking-widest hover:translate-y-[2px]
                  hover:shadow-[1px_1px_0_var(--color-ink)] transition-transform
                  ${active ? "bg-gold text-ink" : "bg-[#ff6154] text-white"}`}
    >
      <span aria-hidden>▲</span>
      {active ? (
        <span>2x boost claimed — active today</span>
      ) : (
        <>
          <span>vote on product hunt</span>
          {/* same pulsing chip as the wardrobe's "new" badge */}
          <span className="bg-gold text-ink border-2 border-ink px-1.5 py-0.5 text-[7px] uppercase animate-pulse">
            click to claim 2x points
          </span>
        </>
      )}
    </a>
  );
}
