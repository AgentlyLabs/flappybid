"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import XConnectButton from "./XConnectButton";
import CoinBalance from "./CoinBalance";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/duels", label: "Duels" },
  { href: "/global-leaderboard", label: "Global" },
  { href: "/rules", label: "Rules" },
  { href: "/hall-of-fame", label: "Hall of Fame" },
] as const;

// A live count of open, joinable pits — the same list the /duels
// matchmaking tab shows. Polls the hub's pit listing on the same 5s beat
// as that page so the badge and the tab never disagree by more than a tick.
function LivePitsBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/arena/pits");
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setCount(Array.isArray(data.open) ? data.open.length : 0);
      } catch {
        // hub down or offline — leave the last count; a zero would blink
      }
    };
    poll();
    const t = setInterval(poll, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (count === 0) return null;
  return (
    <span
      aria-label={`${count} open ${count === 1 ? "pit" : "pits"}`}
      className="ml-1.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 bg-red text-paper border-2 border-ink text-[8px] leading-none align-middle"
    >
      {count}
    </span>
  );
}

// Header nav. Desktop shows the links inline; on mobile they collapse behind
// a burger that drops a full-width panel under the sticky header (the header
// is the positioning context for it). X connect and the theme toggle stay in
// the bar at every size so they're never hidden behind a tap.
export default function HeaderNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="ml-auto flex items-center gap-3 sm:gap-6 font-pixel text-[8px] sm:text-[10px] uppercase">
      <nav className="hidden sm:flex items-center gap-6">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="hover:text-orange-deep">
            {l.label}
            {l.href === "/duels" && <LivePitsBadge />}
          </Link>
        ))}
      </nav>
      <CoinBalance />
      <XConnectButton />
      <ThemeToggle />
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="sm:hidden pixel-btn bg-paper px-2.5 py-2 text-[10px] leading-none"
      >
        <span aria-hidden>{open ? "✕" : "☰"}</span>
      </button>
      {open && (
        <nav className="sm:hidden absolute inset-x-0 top-full bg-sky border-b-4 border-ink flex flex-col font-pixel text-[10px] uppercase shadow-[0_4px_0_rgba(0,0,0,0.28)]">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="px-4 py-3.5 border-t-[3px] border-ink/20 hover:text-orange-deep"
            >
              {l.label}
              {l.href === "/duels" && <LivePitsBadge />}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
