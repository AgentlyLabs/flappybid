"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { composeBird, type ComposedBird } from "@/game/cosmetics";
import { birdFrames, composeFit, FIT_EVENT } from "@/game/wardrobe";
import {
  CHAT_COLORS,
  CHAT_EFFECTS,
  NUDGE_EFFECT,
  encodeChatFit,
  nameColor,
  parseChatFit,
  parseChatEffect,
  parseChatGifUrl,
} from "@/lib/chat";
import { isAdminHandle } from "@/lib/admin";
import { utcDay } from "@/lib/day";
import { BirdSpriteSvg } from "./PixelBird";
import WardrobeModal from "./WardrobeModal";
import { X_LINK_EVENT } from "./XConnectButton";

// Floating chat, pinned to the right edge on every page. Reading is open to
// everyone, but chirping requires a linked X account (server-verified OAuth,
// HttpOnly cookie): messages go out as your real @handle, and the composer
// is a connect button until you link. Old messages from the anonymous era
// keep their generated bird names. Your avatar is your wardrobe bird — each
// message carries the fit you wore when you sent it, so old messages keep
// their look.
// Clicking your bird in the compose row opens the wardrobe; a swatch row
// picks your name color. Messages from before the wardrobe era fall back
// to the seed-recolored bird. Polls while open, goes quiet when closed —
// same cadence philosophy as the presence heartbeat.

interface Msg {
  id: number;
  name: string;
  body: string;
  seed: number;
  fit: string;
  color: string;
  effect: string;
  body_color: string;
  gif_url: string | null;
  x_handle: string;
  recipient: string;
  created_at: string;
}

// one row of the DM inbox: a partner plus the newest message in that thread
interface Convo {
  partner: string;
  id: number;
  body: string;
  gif_url: string | null;
  effect: string;
  fromMe: boolean;
  created_at: string;
}

// which face of the panel is showing: the public room, the DM inbox, or a
// single private thread
type View = "public" | "inbox" | "thread";

// client-side handle shape check, mirrors isXHandle on the server (kept local
// so this client bundle doesn't pull in the server-only x lib)
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// what /api/chat/gif returns per result — preview fills the picker grid,
// send is what the chosen message stores in gif_url
interface GifResult {
  id: string;
  preview: string;
  send: string;
  alt: string;
}

const POLL_MS = 4_000; // the public room, while open
const DM_POLL_MS = 2_000; // an open DM thread — snappier, it's a back-and-forth
const IDLE_POLL_MS = 15_000; // while closed — just enough to spot new chirps

// A message's clock: time of day for today's messages, with the date prefixed
// once a message is older than today so a thread spanning days stays readable.
// Shown in the viewer's local time; the full stamp rides along as a tooltip.
function chatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? time
    : `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`;
}

// site owners get an admin tag next to their linked handle; safe to key off
// x_handle because the server only stamps it on OAuth-verified messages
const isAdmin = isAdminHandle;

function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_645) + 1;
}

// old rows (or clients) without a seed still get a stable bird via the name
function fallbackSeed(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  }
  return ((h >>> 0) % 2_147_483_645) + 1;
}

// Each seed recolors the bird's body + belly — hue plus a few saturation and
// lightness steps, so thousands of visibly distinct birds. Beak and outline
// stay classic so every avatar still reads as "the flappy bird".
const avatarCache = new Map<number, ComposedBird>();
function avatarBird(seed: number): ComposedBird {
  let bird = avatarCache.get(seed);
  if (!bird) {
    const hue = seed % 360;
    const sat = 55 + (Math.floor(seed / 360) % 3) * 12;
    const light = 46 + (Math.floor(seed / 1080) % 3) * 8;
    bird = composeBird({
      id: `chat-${seed}`,
      label: "",
      recolor: {
        Y: `hsl(${hue} ${sat}% ${light}%)`,
        C: `hsl(${hue} ${Math.max(sat - 12, 30)}% ${Math.min(light + 28, 88)}%)`,
      },
    });
    avatarCache.set(seed, bird);
  }
  return bird;
}

// The dressed bird a message carries; null when the fit string is absent
// or invalid, in which case the seed bird above steps in.
const fitCache = new Map<string, ComposedBird | null>();
function fitBird(fit: string): ComposedBird | null {
  if (!fitCache.has(fit)) {
    const parsed = parseChatFit(fit);
    fitCache.set(
      fit,
      parsed
        ? "fit" in parsed
          ? composeFit(parsed.fit)
          : composeBird(parsed.cosmetic)
        : null
    );
  }
  return fitCache.get(fit) ?? null;
}

// Message text with its effect applied. Wave/shake split into per-letter
// spans (inline-block so transforms bite) with index-keyed negative delays;
// spaces stay plain text nodes so long messages still wrap. Rainbow stripes
// letters by index and hue-rotates the whole run. Effects are server-
// validated, so an unknown value here just renders plain.
function ChatBody({
  body,
  effect,
  color,
}: {
  body: string;
  effect: string;
  color: string;
}) {
  const style = color && effect !== "rainbow" ? { color } : undefined;
  if (effect === "wave" || effect === "shake") {
    const wave = effect === "wave";
    return (
      <span style={style}>
        {body.split("").map((ch, i) =>
          ch === " " ? (
            " "
          ) : (
            <span
              key={i}
              className={`inline-block ${wave ? "chat-wave-ch" : "chat-shake-ch"}`}
              style={{
                animationDelay: wave
                  ? `${-((i % 8) * 0.11)}s`
                  : `${-((i % 3) * 0.11)}s`,
              }}
            >
              {ch}
            </span>
          )
        )}
      </span>
    );
  }
  if (effect === "rainbow") {
    return (
      <span className="chat-rainbow">
        {body.split("").map((ch, i) =>
          ch === " " ? (
            " "
          ) : (
            <span key={i} style={{ color: `hsl(${(i * 24) % 360} 75% 40%)` }}>
              {ch}
            </span>
          )
        )}
      </span>
    );
  }
  if (effect === "big") {
    return (
      <span className="font-pixel text-[11px] uppercase align-middle" style={style}>
        {body}
      </span>
    );
  }
  return <span style={style}>{body}</span>;
}

function Avatar({
  fit = "",
  seed,
  name,
}: {
  fit?: string;
  seed: number;
  name: string;
}) {
  const bird = fitBird(fit) ?? avatarBird(seed > 0 ? seed : fallbackSeed(name));
  return (
    <BirdSpriteSvg
      bird={bird}
      className="inline-block w-6 h-[18px] mr-1.5 align-middle shrink-0"
    />
  );
}

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [dressing, setDressing] = useState(false);
  const [msgs, setMsgs] = useState<Msg[] | null | undefined>(undefined);
  // the avatar seed, read lazily; a missing one is generated on first open
  // (an event handler, so the localStorage write isn't a render side effect)
  const [seed, setSeed] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      return Number(localStorage.getItem("fb_chat_seed")) || 0;
    } catch {
      return 0;
    }
  });
  // chosen name color; "" = derived from the handle, same as everyone sees
  const [color, setColor] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const c = localStorage.getItem("fb_chat_color") ?? "";
      return CHAT_COLORS.includes(c) ? c : "";
    } catch {
      return "";
    }
  });
  // your bird as the wardrobe dresses it right now, for the compose row
  const [myBird, setMyBird] = useState<ComposedBird | null>(null);
  // newest message id this browser has had on screen; anything above it
  // counts as unread while the panel is closed
  const [seenId, setSeenId] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      return Number(localStorage.getItem("fb_chat_seen")) || 0;
    } catch {
      return 0;
    }
  });
  // chosen text effect; "" = plain. Remembered like the color swatch.
  const [effect, setEffect] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return parseChatEffect(localStorage.getItem("fb_chat_effect"));
    } catch {
      return "";
    }
  });
  // paint the message body with your name color too?
  const [paint, setPaint] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("fb_chat_paint") === "1";
    } catch {
      return false;
    }
  });
  // true for one beat after someone's nudge lands, to jolt the panel
  const [nudging, setNudging] = useState(false);
  // gif picker: open/closed, live query, results (undefined = searching)
  const [gifOpen, setGifOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState("");
  const [gifs, setGifs] = useState<GifResult[] | undefined>(undefined);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // verified X handle bound to this browser's HttpOnly cookie. undefined =
  // still loading, null = not linked (composer shows the connect gate)
  const [xHandle, setXHandle] = useState<string | null | undefined>(undefined);
  // which face is showing, and the partner handle when a thread is open
  const [view, setView] = useState<View>("public");
  const [peer, setPeer] = useState("");
  const [dmMsgs, setDmMsgs] = useState<Msg[] | null | undefined>(undefined);
  const [convos, setConvos] = useState<Convo[] | null | undefined>(undefined);
  const [newPeer, setNewPeer] = useState("");
  // newest DM id this browser has seen per partner, so a thread stops
  // counting as unread once you've read it — same idea as fb_chat_seen
  const [dmSeen, setDmSeen] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("fb_dm_seen") || "{}") || {};
    } catch {
      return {};
    }
  });
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // is the user scrolled to the bottom?
  const openRef = useRef(false); // mirrors `open` for the fetch callback
  const seenRef = useRef(seenId); // mirrors `seenId` likewise
  const maxIdRef = useRef(0); // newest id from the previous poll — nudge detection

  const markSeen = useCallback((latest: number) => {
    if (latest <= seenRef.current) return;
    seenRef.current = latest;
    setSeenId(latest);
    try {
      localStorage.setItem("fb_chat_seen", String(latest));
    } catch {
      // non-persistent is fine
    }
  }, []);

  const markDmSeen = useCallback((handle: string, latest: number) => {
    setDmSeen((prev) => {
      if ((prev[handle] ?? 0) >= latest) return prev;
      const next = { ...prev, [handle]: latest };
      try {
        localStorage.setItem("fb_dm_seen", JSON.stringify(next));
      } catch {
        // non-persistent is fine
      }
      return next;
    });
  }, []);

  const openPanel = useCallback(() => {
    if (!seed) {
      const s = randomSeed();
      setSeed(s);
      try {
        localStorage.setItem("fb_chat_seed", String(s));
      } catch {
        // non-persistent is fine
      }
    }
    openRef.current = true;
    setOpen(true);
  }, [seed]);

  const closePanel = () => {
    openRef.current = false;
    setOpen(false);
  };

  const pickColor = (c: string) => {
    const next = c === color ? "" : c; // tap the active swatch to reset
    setColor(next);
    try {
      localStorage.setItem("fb_chat_color", next);
    } catch {
      // non-persistent is fine
    }
  };

  const pickEffect = (fx: string) => {
    const next = fx === effect ? "" : fx; // tap the active chip to go plain
    setEffect(next);
    try {
      localStorage.setItem("fb_chat_effect", next);
    } catch {
      // non-persistent is fine
    }
  };

  const togglePaint = () => {
    setPaint((p) => {
      try {
        localStorage.setItem("fb_chat_paint", p ? "" : "1");
      } catch {
        // non-persistent is fine
      }
      return !p;
    });
  };

  // who is this browser linked to on X? (server reads the HttpOnly cookie)
  useEffect(() => {
    fetch("/api/x/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setXHandle(d?.handle ?? null))
      .catch(() => {
        // unknown link state — show the connect gate; linking again is harmless
        setXHandle(null);
      });
  }, []);

  // landing back from the OAuth flow: strip the ?x= flag and surface the
  // outcome in the open panel (the effect no-ops on every later run)
  useEffect(() => {
    const url = new URL(window.location.href);
    const flag = url.searchParams.get("x");
    if (!flag) return;
    url.searchParams.delete("x");
    window.history.replaceState(null, "", url);
    openPanel();
    if (flag === "denied") setError("x link cancelled");
    else if (flag === "error") setError("x link failed — try again");
  }, [openPanel]);

  // the header connect/disconnect button broadcasts link changes
  useEffect(() => {
    const onLink = (e: Event) =>
      setXHandle((e as CustomEvent<string | null>).detail);
    window.addEventListener(X_LINK_EVENT, onLink);
    return () => window.removeEventListener(X_LINK_EVENT, onLink);
  }, []);

  // keep the compose-row bird in sync with the wardrobe while open
  useEffect(() => {
    if (!open) return;
    const update = () => setMyBird(birdFrames(utcDay())[0]);
    update();
    window.addEventListener(FIT_EVENT, update);
    return () => window.removeEventListener(FIT_EVENT, update);
  }, [open]);

  const fetchPublic = useCallback(async () => {
    try {
      const res = await fetch("/api/chat");
      if (!res.ok) return;
      const d = await res.json();
      const list: Msg[] | null = d.messages ?? null;
      setMsgs(list);
      if (list?.length) {
        const newest = list[list.length - 1].id;
        // a nudge that arrived since the last poll jolts the whole panel —
        // but never on the first poll, else opening the page replays an old one
        const prevMax = maxIdRef.current;
        if (
          prevMax > 0 &&
          list.some((m) => m.id > prevMax && m.effect === NUDGE_EFFECT)
        ) {
          setNudging(true);
          setTimeout(() => setNudging(false), 700);
        }
        maxIdRef.current = Math.max(prevMax, newest);
        // whatever lands on screen while the public room is open counts as
        // read (fetchPublic only runs while viewing public or when closed)
        if (openRef.current) markSeen(newest);
      }
    } catch {
      // keep last known messages
    }
  }, [markSeen]);

  // the DM inbox powers the DMs-tab badge and the conversation list; polled
  // whenever the browser is linked so unread stays live in every view
  const fetchInbox = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/dms");
      if (!res.ok) return;
      const d = await res.json();
      setConvos(d.conversations ?? null);
    } catch {
      // keep last known inbox
    }
  }, []);

  // a single private thread; reading it on screen marks it seen
  const fetchThread = useCallback(
    async (handle: string) => {
      try {
        const res = await fetch(`/api/chat?with=${encodeURIComponent(handle)}`);
        if (!res.ok) return;
        const d = await res.json();
        const list: Msg[] | null = d.messages ?? null;
        setDmMsgs(list);
        if (list?.length && openRef.current) {
          markDmSeen(handle, list[list.length - 1].id);
        }
      } catch {
        // keep last known thread
      }
    },
    [markDmSeen]
  );

  const openThread = useCallback(
    (handle: string) => {
      setPeer(handle);
      setView("thread");
      setDmMsgs(undefined);
      setError("");
      pinnedRef.current = true;
      fetchThread(handle);
    },
    [fetchThread]
  );

  // poll fast while open; slowly while closed so the button can bump and
  // badge when someone chirps or DMs. The public feed and DM inbox both feed
  // the closed-button badge, so both are polled unless a thread is open.
  useEffect(() => {
    const inThread = open && view === "thread" && !!peer;
    const tick = () => {
      if (inThread) fetchThread(peer);
      // public feed only while viewing it or closed — not behind the inbox,
      // so its read marks don't clear while you're reading DMs
      else if (!open || view === "public") fetchPublic();
      // the inbox feeds the DMs-tab badge (hidden inside a thread) and the
      // closed-button badge — so skip its scan while a thread is open, but
      // always run it when closed so a new DM still lights the button
      if (xHandle && !inThread) fetchInbox();
    };
    tick();
    // an open thread polls faster than the room — DMs read as a conversation
    const every = !open ? IDLE_POLL_MS : inThread ? DM_POLL_MS : POLL_MS;
    const t = setInterval(tick, every);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, view, peer, xHandle, fetchPublic, fetchInbox, fetchThread]);

  // stick to the newest message unless the user scrolled up to read history
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs, dmMsgs, view]);

  // gif search, debounced while typing; an empty query shows trending.
  // `live` guards against a slow response landing after a newer query.
  // (the "searching…" reset happens in the button/input handlers — an
  // effect body shouldn't setState synchronously)
  useEffect(() => {
    if (!gifOpen) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/chat/gif?q=${encodeURIComponent(gifQuery.trim())}`
        );
        const d = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok) {
          setGifs([]);
          setError(d?.error ?? "gif search failed");
          return;
        }
        setGifs(d?.gifs ?? []);
      } catch {
        if (live) {
          setGifs([]);
          setError("network error — try again");
        }
      }
    }, gifQuery ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [gifOpen, gifQuery]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = input.trim();
    if (!body || sending || !xHandle) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          seed,
          fit: encodeChatFit(utcDay()),
          color,
          effect,
          // painting sends the name color (chosen or derived) as body color
          bodyColor: paint ? color || nameColor(`@${xHandle}`) : "",
          recipient: view === "thread" ? peer : undefined,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? "could not send");
        return;
      }
      setInput("");
      pinnedRef.current = true;
      afterSend(d?.recipient);
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  };

  // refresh whatever's on screen after a successful send. For a DM, the
  // server echoes the canonical recipient — adopt it so a handle typed in
  // any case matches the thread query going forward.
  const afterSend = (canonRecipient?: string) => {
    if (view === "thread") {
      const canon = canonRecipient || peer;
      if (canon !== peer) setPeer(canon);
      fetchThread(canon);
      fetchInbox();
    } else {
      fetchPublic();
    }
  };

  // clicking a gif sends it right away, carrying whatever text is typed as
  // the body — same fields as a normal chirp otherwise
  const sendGif = async (g: GifResult) => {
    if (sending || !xHandle) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: input.trim(),
          gif: g.send,
          seed,
          fit: encodeChatFit(utcDay()),
          color,
          effect,
          bodyColor: paint ? color || nameColor(`@${xHandle}`) : "",
          recipient: view === "thread" ? peer : undefined,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? "could not send");
        return;
      }
      setInput("");
      setGifOpen(false);
      pinnedRef.current = true;
      afterSend(d?.recipient);
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  };

  // a nudge is a bodiless event: the server stamps the effect, every open
  // panel jolts when it lands. Server enforces one per device per 30s.
  const sendNudge = async () => {
    if (sending || !xHandle) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seed,
          fit: encodeChatFit(utcDay()),
          color,
          nudge: true,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? "could not nudge");
        return;
      }
      pinnedRef.current = true;
      fetchPublic();
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  };

  // start a DM with a hand-typed @handle from the inbox
  const startDm = (e: React.FormEvent) => {
    e.preventDefault();
    const h = newPeer.trim().replace(/^@/, "");
    if (!HANDLE_RE.test(h)) {
      setError("enter a valid @handle");
      return;
    }
    if (xHandle && h.toLowerCase() === xHandle.toLowerCase()) {
      setError("that's you");
      return;
    }
    setNewPeer("");
    openThread(h);
  };

  // unread DM threads: newest message is theirs and lands past our read mark
  const dmUnread =
    convos?.filter((c) => !c.fromMe && c.id > (dmSeen[c.partner] ?? 0))
      .length ?? 0;

  // one message row, shared by the public room and a DM thread. In the public
  // room a linked @handle (not yours) is a button that opens a DM with them.
  const renderMsg = (m: Msg, clickable: boolean) => {
    // re-validated on render so a hand-edited row can't hotlink beyond the
    // two gif CDNs the picker uses
    const gif = parseChatGifUrl(m.gif_url ?? "");
    const label = m.x_handle ? `@${m.x_handle}` : m.name;
    const nameStyle = {
      color: m.color || nameColor(m.x_handle ? `@${m.x_handle}` : m.name),
    };
    const canDm =
      clickable &&
      !!m.x_handle &&
      !!xHandle &&
      m.x_handle.toLowerCase() !== xHandle.toLowerCase();
    const adminTag = isAdmin(m.x_handle) && (
      <span className="ml-1 px-1 py-0.5 bg-orange text-white text-[6px] uppercase">
        admin
      </span>
    );
    return (
      <p key={m.id} className="break-words">
        <Avatar fit={m.fit} seed={m.seed} name={m.name} />
        {canDm ? (
          <button
            type="button"
            onClick={() => openThread(m.x_handle)}
            title={`message @${m.x_handle}`}
            className="font-pixel text-[8px] mr-2 align-middle cursor-pointer hover:underline"
            style={nameStyle}
          >
            {label}
            <span className="ml-1 text-muted">𝕏</span>
            {adminTag}
          </button>
        ) : (
          <span
            className="font-pixel text-[8px] mr-2 align-middle"
            style={nameStyle}
            title={m.x_handle ? "linked X account" : undefined}
          >
            {label}
            {m.x_handle && <span className="ml-1 text-muted">𝕏</span>}
            {adminTag}
          </span>
        )}
        <span
          className="font-pixel text-[7px] text-muted mr-2 align-middle"
          title={new Date(m.created_at).toLocaleString()}
        >
          {chatTime(m.created_at)}
        </span>
        {m.effect === NUDGE_EFFECT ? (
          <span className="text-muted">sent a nudge 👋</span>
        ) : (
          <>
            {m.body && (
              <ChatBody body={m.body} effect={m.effect} color={m.body_color} />
            )}
            {gif && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={gif}
                alt="gif"
                loading="lazy"
                className="block mt-1 max-h-32 max-w-[80%] border-2 border-ink"
              />
            )}
          </>
        )}
      </p>
    );
  };

  if (!open) {
    const publicUnread = msgs?.filter((m) => m.id > seenId).length ?? 0;
    const unread = publicUnread + dmUnread;
    const latestId = Math.max(
      msgs?.length ? msgs[msgs.length - 1].id : 0,
      convos?.length ? convos[0].id : 0
    );
    return (
      // keyed by the newest id so the bump replays on every fresh chirp
      <button
        key={latestId}
        onClick={openPanel}
        className={`fixed bottom-4 right-4 z-40 [.arena-open_&]:z-[60] pixel-btn bg-orange text-white font-pixel text-[9px] px-4 py-3 ${
          unread > 0 ? "chat-bump" : ""
        }`}
        aria-label={
          unread > 0 ? `Open chat — ${unread} new messages` : "Open chat"
        }
      >
        💬 chat
        {unread > 0 && (
          <span className="absolute -top-2.5 -right-2.5 min-w-5 h-5 px-1 bg-red text-white border-2 border-ink font-pixel text-[8px] flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className={`fixed bottom-4 right-4 z-40 [.arena-open_&]:z-[60] w-[calc(100vw-2rem)] max-w-80 h-[26rem] max-h-[70vh] sm:max-w-[26rem] sm:h-[34rem] sm:max-h-[80vh] flex flex-col bg-paper border-[3px] border-ink shadow-[6px_6px_0_rgba(0,0,0,0.35)] ${
        nudging ? "chat-nudge" : ""
      }`}
    >
      <div className="shrink-0 flex items-center justify-between px-3 py-2 bg-sand border-b-[3px] border-ink">
        {view === "thread" ? (
          <button
            onClick={() => {
              setView("inbox");
              setError("");
            }}
            className="font-pixel text-[9px] uppercase truncate hover:text-orange-deep"
            title="back to DMs"
          >
            ‹ @{peer}
          </button>
        ) : xHandle ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setView("public");
                setError("");
              }}
              className={`font-pixel text-[9px] uppercase ${
                view === "public" ? "" : "text-muted hover:text-ink"
              }`}
            >
              bird chat
            </button>
            <button
              onClick={() => {
                setView("inbox");
                setError("");
              }}
              className={`font-pixel text-[9px] uppercase relative ${
                view === "inbox" ? "" : "text-muted hover:text-ink"
              }`}
            >
              DMs
              {dmUnread > 0 && (
                <span className="absolute -top-2 -right-3 min-w-4 h-4 px-1 bg-red text-white border-2 border-ink font-pixel text-[7px] flex items-center justify-center">
                  {dmUnread > 9 ? "9+" : dmUnread}
                </span>
              )}
            </button>
          </div>
        ) : (
          <span className="font-pixel text-[9px] uppercase">bird chat</span>
        )}
        <button
          onClick={closePanel}
          className="font-pixel text-xs px-2 -mr-1 hover:text-orange-deep"
          aria-label="Close chat"
        >
          X
        </button>
      </div>

      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (el) {
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }
        }}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-1.5 text-lg leading-snug"
      >
        {view === "inbox" ? (
          <>
            <form onSubmit={startDm} className="flex gap-1.5 mb-1 shrink-0">
              <input
                value={newPeer}
                onChange={(e) => setNewPeer(e.target.value)}
                maxLength={16}
                placeholder="@handle to message…"
                className="flex-1 min-w-0 border-2 border-ink bg-paper px-2 py-1 text-base outline-none focus:border-orange-deep"
              />
              <button
                type="submit"
                className="pixel-btn bg-orange text-white font-pixel text-[8px] px-3 shrink-0"
              >
                go
              </button>
            </form>
            {convos === undefined && (
              <p className="text-muted text-center my-auto">loading…</p>
            )}
            {convos === null && (
              <p className="text-muted text-center my-auto">
                DMs are warming up — try again in a minute
              </p>
            )}
            {convos && convos.length === 0 && (
              <p className="text-muted text-center my-auto">
                no DMs yet — start one above, or tap a name in bird chat
              </p>
            )}
            {convos?.map((c) => {
              const unread = !c.fromMe && c.id > (dmSeen[c.partner] ?? 0);
              const snippet =
                c.effect === NUDGE_EFFECT
                  ? "👋 nudge"
                  : c.body || (c.gif_url ? "📷 gif" : "");
              return (
                <button
                  key={c.partner}
                  onClick={() => openThread(c.partner)}
                  className="shrink-0 flex items-center gap-2 text-left border-2 border-ink/20 hover:border-ink px-2 py-1.5"
                >
                  <span
                    className="font-pixel text-[8px] shrink-0"
                    style={{ color: nameColor(`@${c.partner}`) }}
                  >
                    @{c.partner}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-base text-muted">
                    {c.fromMe ? "you: " : ""}
                    {snippet}
                  </span>
                  <span
                    className="shrink-0 font-pixel text-[7px] text-muted"
                    title={new Date(c.created_at).toLocaleString()}
                  >
                    {chatTime(c.created_at)}
                  </span>
                  {unread && (
                    <span className="shrink-0 w-2.5 h-2.5 bg-red border-2 border-ink" />
                  )}
                </button>
              );
            })}
          </>
        ) : (
          (() => {
            const list = view === "thread" ? dmMsgs : msgs;
            return (
              <>
                {list === undefined && (
                  <p className="text-muted text-center my-auto">loading…</p>
                )}
                {list === null && (
                  <p className="text-muted text-center my-auto">
                    chat is warming up — try again in a minute
                  </p>
                )}
                {list && list.length === 0 && (
                  <p className="text-muted text-center my-auto">
                    {view === "thread"
                      ? `say hi to @${peer}`
                      : "nobody has chirped yet — say hi"}
                  </p>
                )}
                {list?.map((m) => renderMsg(m, view === "public"))}
              </>
            );
          })()
        )}
      </div>

      {/* unlinked browsers read freely but see the connect gate instead of
          the composer; while the link state is still loading, show neither */}
      {xHandle === null && (
        <div className="shrink-0 border-t-[3px] border-ink px-3 py-4 text-center">
          <p className="text-lg mb-2.5">
            chirps carry your real @handle — no anons in bird chat
          </p>
          <a
            href="/api/x/connect"
            className="pixel-btn bg-orange text-white font-pixel text-[8px] px-4 py-2.5 inline-block"
          >
            connect 𝕏 to chat
          </a>
          {error && <p className="pt-2 text-base text-red">{error}</p>}
        </div>
      )}
      {xHandle && view !== "inbox" && (
      <div className="shrink-0 border-t-[3px] border-ink">
        <div className="flex items-center gap-2 px-3 pt-1.5">
          <button
            onClick={() => setDressing(true)}
            title="Dress your bird — this is your chat avatar"
            aria-label="Open the wardrobe"
            className="shrink-0 cursor-pointer flex flex-col items-center gap-0.5 hover:-translate-y-0.5 transition-transform group"
          >
            {myBird ? (
              <BirdSpriteSvg bird={myBird} className="w-6 h-[18px]" />
            ) : (
              <Avatar seed={seed} name={xHandle} />
            )}
            <span className="font-pixel text-[6px] uppercase text-muted group-hover:text-orange-deep leading-none">
              fit
            </span>
          </button>
          <label className="flex-1 min-w-0 flex items-baseline gap-2 font-pixel text-[7px] uppercase text-muted">
            chirping as
            <span
              className="flex-1 min-w-0 truncate normal-case"
              style={{ color: color || nameColor(`@${xHandle}`) }}
              title="your linked X account"
            >
              @{xHandle}
              {isAdmin(xHandle) && (
                <span className="ml-1 px-1 py-0.5 bg-orange text-white text-[6px] uppercase">
                  admin
                </span>
              )}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-1.5 px-3 pt-1.5">
          {CHAT_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => pickColor(c)}
              title={c === color ? "your name color — tap to reset" : "name color"}
              aria-label={`Name color ${c}`}
              className={`w-3.5 h-3.5 shrink-0 cursor-pointer border-2 ${
                c === color
                  ? "border-ink scale-125"
                  : "border-ink/25 hover:border-ink"
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5 px-3 pt-1.5">
          {CHAT_EFFECTS.map((fx) => (
            <button
              key={fx}
              type="button"
              onClick={() => pickEffect(fx)}
              title={
                fx === effect
                  ? "your text effect — tap to go plain"
                  : `${fx} text`
              }
              className={`pixel-btn font-pixel text-[7px] px-1.5 py-1 cursor-pointer ${
                fx === effect ? "bg-gold" : "bg-paper"
              }`}
            >
              {fx}
            </button>
          ))}
          <button
            type="button"
            onClick={togglePaint}
            title="paint your message text with your name color"
            aria-pressed={paint}
            className={`pixel-btn font-pixel text-[7px] px-1.5 py-1 cursor-pointer ${
              paint ? "bg-gold" : "bg-paper"
            }`}
          >
            🖌
          </button>
          <button
            type="button"
            onClick={() => {
              setGifs(undefined);
              setGifOpen((o) => !o);
            }}
            title="send a gif"
            aria-pressed={gifOpen}
            className={`pixel-btn font-pixel text-[7px] px-1.5 py-1 cursor-pointer ${
              gifOpen ? "bg-gold" : "bg-paper"
            }`}
          >
            gif
          </button>
          {view !== "thread" && (
            <button
              type="button"
              onClick={sendNudge}
              disabled={sending}
              title="shake everyone's chat — one per 30s"
              className="ml-auto pixel-btn bg-paper font-pixel text-[7px] px-1.5 py-1 cursor-pointer hover:bg-gold disabled:opacity-50"
            >
              👋 nudge
            </button>
          )}
        </div>
        {gifOpen && (
          <div className="px-3 pt-1.5">
            <input
              value={gifQuery}
              onChange={(e) => {
                setGifs(undefined);
                setGifQuery(e.target.value);
              }}
              maxLength={50}
              placeholder="search gifs…"
              className="w-full border-2 border-ink bg-paper px-2 py-1 text-base outline-none focus:border-orange-deep"
            />
            <div className="mt-1.5 h-32 overflow-y-auto grid grid-cols-3 gap-1.5 content-start">
              {gifs === undefined && (
                <p className="col-span-3 text-muted text-center my-auto text-base">
                  searching…
                </p>
              )}
              {gifs && gifs.length === 0 && (
                <p className="col-span-3 text-muted text-center my-auto text-base">
                  no gifs found
                </p>
              )}
              {gifs?.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => sendGif(g)}
                  disabled={sending}
                  title={g.alt}
                  className="cursor-pointer border-2 border-ink/25 hover:border-ink disabled:opacity-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={g.preview}
                    alt={g.alt}
                    loading="lazy"
                    className="w-full h-16 object-cover"
                  />
                </button>
              ))}
            </div>
            <p className="font-pixel text-[6px] uppercase text-muted pt-1">
              tap a gif to send it · powered by giphy &amp; tenor
            </p>
          </div>
        )}
        {error && <p className="px-3 pt-1 text-base text-red">{error}</p>}
        <form onSubmit={send} className="flex gap-2 p-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={240}
            placeholder={view === "thread" ? `message @${peer}…` : "say something…"}
            className="flex-1 min-w-0 border-2 border-ink bg-paper px-2 py-1.5 text-lg outline-none focus:border-orange-deep"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="pixel-btn bg-orange text-white font-pixel text-[8px] px-3 shrink-0 disabled:opacity-50"
          >
            {sending ? "…" : "send"}
          </button>
        </form>
      </div>
      )}

      {dressing && <WardrobeModal onClose={() => setDressing(false)} />}
    </div>
  );
}
