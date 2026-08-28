"use client";

import { useEffect, useState } from "react";

// Site-wide announcement modal, mounted once in the root layout. Fetches the
// live announcements on mount and shows the oldest one this browser has not
// dismissed yet; OK, the X and the backdrop all dismiss it FOREVER for this
// browser (id remembered in localStorage — there are no accounts to pin it
// to). Several undismissed announcements queue up one after another.

interface Announcement {
  id: string;
  title: string;
  body: string;
}

const SEEN_KEY = "fb_seen_announcements";
const SEEN_CAP = 100; // ids kept; older ones only guard retired announcements

function seenIds(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function markSeen(id: string) {
  try {
    const next = [...seenIds().filter((x) => x !== id), id].slice(-SEEN_CAP);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — the in-memory queue still advances, the
    // modal just comes back next visit
  }
}

export default function AnnouncementModal() {
  const [queue, setQueue] = useState<Announcement[]>([]);

  useEffect(() => {
    fetch("/api/announcements")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const all: Announcement[] = d?.announcements ?? [];
        const seen = new Set(seenIds());
        setQueue(all.filter((a) => !seen.has(a.id)));
      })
      .catch(() => {});
  }, []);

  const current = queue[0];
  if (!current) return null;

  const dismiss = () => {
    markSeen(current.id);
    setQueue((q) => q.slice(1));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      onClick={dismiss}
    >
      <div
        className="pixel-panel w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b-[3px] border-ink bg-orange px-4 py-2 flex items-center justify-between gap-4">
          <span className="font-pixel text-[9px] uppercase tracking-wider text-white">
            📢 announcement
          </span>
          <button
            onClick={dismiss}
            className="font-pixel text-xs text-white hover:text-gold"
            aria-label="Close"
          >
            X
          </button>
        </div>
        <div className="p-6">
          {current.title && (
            <h2 className="font-pixel text-sm leading-relaxed">
              {current.title}
            </h2>
          )}
          <p className={`text-xl whitespace-pre-line ${current.title ? "mt-3" : ""}`}>
            {current.body}
          </p>
          <button
            onClick={dismiss}
            className="pixel-btn bg-orange text-white text-xs px-8 py-3 mt-5 w-full"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
