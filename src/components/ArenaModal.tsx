"use client";

// The live arena client: ticket → lobby → the OSRS options screen →
// 3-second count → click your opponent → fight on the server's tick.
// The server owns the sim; this renders snapshots and fires intents.

import { useCallback, useEffect, useRef, useState } from "react";
import { WIDTH, HEIGHT } from "@/game/constants";
import {
  ARENA_VERSION,
  MAX_WAGER,
  TICK_MS,
  WEAPONS,
  normalizeArenaOptions,
  type ArenaOptions,
  type ArenaSnapshot,
} from "@/game/arena";
import { COIN_BALANCE_EVENT } from "@/lib/coins";
import {
  drawArena,
  birdHitbox,
  type SplatAnim,
  type SwingAnim,
} from "@/game/arenaRender";
import { drawWeaponIcon } from "@/game/weaponFx";
import { sfx } from "@/game/sound";
import { ensureHuman } from "@/lib/human-client";

export type ArenaEntry =
  | { kind: "create" }
  | { kind: "bot" }
  | { kind: "join"; code?: string }
  // walking back into your own pit after a refresh/nav — joins immediately,
  // fails silently (a dead code just means the pit closed while you were out)
  | { kind: "rejoin"; code: string }
  | { kind: "spectate"; code: string };

type Phase =
  | "gate" // fetching the ticket
  | "options" // create: pick your terms
  | "code" // join: type the pit code
  | "waiting" // in a room, no opponent yet
  | "review" // both seated: accept the terms
  | "countdown"
  | "fight"
  | "result"
  | "error";

// tickets live 10 minutes server-side; reuse one per tab instead of
// minting on every modal open (which is what tripped the gate's limiter)
let cachedTicket: {
  ticket: string;
  handle: string | null;
  exp: number;
} | null = null;

async function fetchTicket(): Promise<
  | { ok: true; ticket: string; handle: string | null }
  | { ok: false; error: string }
> {
  if (cachedTicket && cachedTicket.exp > Date.now()) {
    return { ok: true, ticket: cachedTicket.ticket, handle: cachedTicket.handle };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let res = await fetch("/api/arena/ticket", { method: "POST" });
    let data = await res.json();
    if (!res.ok && data.humanCheck && (await ensureHuman())) {
      res = await fetch("/api/arena/ticket", { method: "POST" });
      data = await res.json();
    }
    if (res.status === 429 && attempt === 0) {
      // two windows on one connection racing the gate — queue politely
      await new Promise((r) => setTimeout(r, 1_100));
      continue;
    }
    if (!res.ok) return { ok: false, error: data.error ?? "the arena gate is stuck" };
    if (data.version !== ARENA_VERSION) {
      return { ok: false, error: "the arena was updated — refresh the page" };
    }
    const handle = typeof data.handle === "string" ? data.handle : null;
    cachedTicket = { ticket: data.ticket, handle, exp: Date.now() + 8 * 60 * 1000 };
    return { ok: true, ticket: data.ticket, handle };
  }
  return { ok: false, error: "the arena gate is stuck" };
}

function loadName(): string {
  try {
    return localStorage.getItem("fb_duel_name") ?? "";
  } catch {
    return "";
  }
}

// a hosted pit outlives its socket server-side (until cancel or the
// 30-minute sweep); this stash is how a refreshed tab finds its way back.
// sessionStorage on purpose — a second tab must not auto-claim the seat.
const PIT_KEY = "fb_pit";
function savePit(code: string) {
  try {
    sessionStorage.setItem(PIT_KEY, code);
  } catch {
    // fine
  }
}
function clearPit() {
  try {
    sessionStorage.removeItem(PIT_KEY);
  } catch {
    // fine
  }
}
export function stashedPit(): string {
  try {
    return sessionStorage.getItem(PIT_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function ArenaModal({
  entry,
  onClose,
}: {
  entry: ArenaEntry;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("gate");
  const [errorMsg, setErrorMsg] = useState("");
  const [nickname, setNickname] = useState(loadName);
  // the default duel is lean: no food, no spec — weapon timing decides.
  // food and spec are opt-ins for longer skill duels.
  const [options, setOptions] = useState<ArenaOptions>(
    normalizeArenaOptions({ noFood: true, noSpec: true })
  );
  const [code, setCode] = useState(entry.kind === "join" ? (entry.code ?? "") : "");
  const [roomCode, setRoomCode] = useState("");
  // when the open pit auto-closes (server ROOM_TTL_MS) — drives the waiting
  // countdown so the host knows how long the seat stays open
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [names, setNames] = useState<[string, string]>(["", ""]);
  const [youAre, setYouAre] = useState<0 | 1>(0);
  const [snap, setSnap] = useState<ArenaSnapshot | null>(null);
  const [peerBlip, setPeerBlip] = useState(false);
  const [listed, setListed] = useState(true);
  const [readyPair, setReadyPair] = useState<[boolean, boolean]>([false, false]);
  const [xHandle, setXHandle] = useState<string | null>(null);
  // the fighter's coin wallet, for staking a wager. Read from /api/wallet and
  // kept fresh on focus / after a wagered fight settles — the escrow is the
  // real gate, this only shapes the UI (disables an unaffordable stake).
  const [balance, setBalance] = useState(0);
  // creators drop back to the board while the pit waits — the socket (and
  // the pit) live in this component, so we hide the modal instead of
  // unmounting it, and pop it back open when a challenger steps in.
  // a rejoin starts minimized: the pill was what the refresh interrupted
  const [minimized, setMinimized] = useState(entry.kind === "rejoin");
  const nickOk = /^[A-Z0-9_-]{3,12}$/.test(nickname.trim().toUpperCase());
  // PvP seats are X-gated (the hub enforces it — this only shapes the UI);
  // the bot just wants any printable bird name
  const canStart = entry.kind === "bot" ? nickOk : xHandle !== null;

  const wsRef = useRef<WebSocket | null>(null);
  const ticketRef = useRef("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<ArenaSnapshot | null>(null);
  const splatsRef = useRef<SplatAnim[]>([]);
  const lastTickAtRef = useRef(0);
  const countdownRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("gate");
  const namesRef = useRef<[string, string]>(["", ""]);
  const youAreRef = useRef<0 | 1>(0);
  const verdictRef = useRef<{
    winner: number;
    reason: string;
    dmg: [number, number];
  } | null>(null);
  // the coin swing of the fight just finished (null for a friendly pit) —
  // drives the stake line under the result banner. winner is snapshotted here
  // (not read from verdictRef during render) so the outcome line is a pure
  // function of state.
  const [resultPot, setResultPot] = useState<{
    wager: number;
    pot: number;
    winner: number;
  } | null>(null);
  const rafRef = useRef(0);
  const swingsRef = useRef<SwingAnim[]>([]);
  const clickedEngageRef = useRef(false);

  // local echo: the server owns the fight, but a button that waits a full
  // 600ms tick (plus the round trip) to light up reads as dropped input.
  // Presses reflect immediately and pulse until the next snapshot confirms
  // them; an echo the server never honors (eat at full hp, spec with no
  // energy) expires after two ticks and the UI falls back to the truth.
  const [pendingWeapon, setPendingWeapon] = useState<number | null>(null);
  const [pendingEat, setPendingEat] = useState(false);
  const [pendingSpec, setPendingSpec] = useState(false);
  const pendingTickRef = useRef({ w: 0, e: 0, s: 0 });
  // flips once the hub seats us — before that, a rejoin failure is just a
  // stale stash, not something worth an error screen
  const gotRoomRef = useRef(false);
  // a deliberate goodbye (unmount, cancel) must not trigger the reclaim
  // that a silent socket drop does
  const teardownRef = useRef(false);
  // the reclaim inside onclose calls back into connect — through a ref,
  // since a callback can't list itself as a dependency
  const connectRef = useRef<(hello: Record<string, unknown>) => void>(() => {});

  // the render loop and socket handler read this; keep it in step
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const fail = useCallback(
    (msg: string) => {
      if (entry.kind === "rejoin" && !gotRoomRef.current) {
        // the pit closed while we were away — drop the stash, no drama
        clearPit();
        onClose();
        return;
      }
      setErrorMsg(msg);
      setMinimized(false);
      setPhase("error");
    },
    [entry.kind, onClose]
  );

  // ---- coin wallet (for staking a wager) --------------------------------

  const refreshBalance = useCallback(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.balance === "number") setBalance(d.balance);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshBalance();
    // a purchase in the header wallet (or another tab) lands here too, so a
    // fighter who just topped up can stake it without reopening the pit
    const onFocus = () => refreshBalance();
    const onCoins = (e: Event) => {
      const n = (e as CustomEvent).detail;
      if (typeof n === "number") setBalance(n);
      else refreshBalance();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(COIN_BALANCE_EVENT, onCoins);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(COIN_BALANCE_EVENT, onCoins);
    };
  }, [refreshBalance]);

  const connect = useCallback(
    (hello: Record<string, unknown>) => {
      // PvP fight names ARE the X handle — the hub enforces the same rule,
      // this just keeps the lobby preview honest. The bot takes any name.
      const name =
        entry.kind !== "bot" && xHandle
          ? xHandle.toUpperCase().slice(0, 15)
          : nickname.trim().toUpperCase();
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/arena`);
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.send(
          JSON.stringify({
            ...hello,
            ticket: ticketRef.current,
            nickname: name,
          })
        );
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.t) {
          case "lobby": {
            // a lobby means we hold seat 0 — remember the pit so a refresh
            // walks back in instead of orphaning it. a fresh challenge
            // tucks into the pill; a reclaim keeps whatever was on screen
            const reclaimed = gotRoomRef.current;
            gotRoomRef.current = true;
            setRoomCode(String(msg.code ?? ""));
            savePit(String(msg.code ?? ""));
            setExpiresAt(
              typeof msg.expiresAt === "number" ? msg.expiresAt : null
            );
            setYouAre((Number(msg.youAre) === 1 ? 1 : 0) as 0 | 1);
            setPhase("waiting");
            if (entry.kind === "create" && !reclaimed) setMinimized(true);
            break;
          }
          case "review": {
            gotRoomRef.current = true;
            setRoomCode(String(msg.code ?? ""));
            const n = msg.names as [string, string];
            setNames(n);
            namesRef.current = n;
            const me = (Number(msg.youAre) === 1 ? 1 : 0) as 0 | 1;
            setYouAre(me);
            youAreRef.current = me;
            setOptions(normalizeArenaOptions(msg.options));
            setReadyPair([false, false]);
            setMinimized(false);
            setPhase("review");
            sfx.pop();
            break;
          }
          case "ready":
            setReadyPair((msg.ready as [boolean, boolean]) ?? [false, false]);
            break;
          case "begin": {
            gotRoomRef.current = true;
            // from the bell on, a refresh is a forfeit, not a reclaim
            clearPit();
            const spec = Number(msg.youAre) === -1;
            const me = (Number(msg.youAre) === 1 ? 1 : 0) as 0 | 1;
            if (spec) {
              // ringside: render from seat 0's corner, no controls
              countdownRef.current = null;
            }
            setYouAre(me);
            youAreRef.current = me;
            const n = msg.names as [string, string];
            setNames(n);
            namesRef.current = n;
            setOptions(normalizeArenaOptions(msg.options));
            splatsRef.current = [];
            swingsRef.current = [];
            clickedEngageRef.current = false;
            snapRef.current = null;
            setSnap(null);
            setPendingWeapon(null);
            setPendingEat(false);
            setPendingSpec(false);
            verdictRef.current = null;
            setMinimized(false);
            setPhase("countdown");
            break;
          }
          case "count": {
            const n = Number(msg.n);
            countdownRef.current = n;
            if (n === 0) {
              setPhase("fight");
              sfx.pop();
              // FIGHT! flashes briefly, then the prompt takes over
              setTimeout(() => {
                countdownRef.current = null;
              }, 700);
            } else {
              sfx.score(0);
            }
            break;
          }
          case "tick": {
            const s = msg.snap as ArenaSnapshot;
            snapRef.current = s;
            lastTickAtRef.current = performance.now();
            setSnap(s);
            for (const e of s.events) {
              // stamp what the attacker held — the renderer keys the swing
              // arc, the spec's signature impact and the foley off it
              const atk = s.fighters[e.actor];
              const held = atk ? WEAPONS[atk.weapon]?.key ?? "scim" : "scim";
              splatsRef.current.push({ ...e, at: performance.now(), weapon: held });
              if (e.kind !== "eat" && e.kind !== "ko") {
                swingsRef.current.push({
                  actor: e.actor,
                  at: performance.now(),
                  weapon: held,
                  kind: e.kind,
                });
                if (swingsRef.current.length > 8) swingsRef.current.shift();
                sfx.weaponSwing(held, e.kind);
              } else if (e.kind === "eat") {
                sfx.score(0);
              }
            }
            if (splatsRef.current.length > 24) {
              splatsRef.current.splice(0, splatsRef.current.length - 24);
            }
            // reconcile the local echo: confirmed presses settle into the
            // snapshot, honored-elsewhere or ignored ones expire after two
            // ticks (one for the intent to ride, one for slack)
            {
              const meIdx = youAreRef.current;
              const mine = s.fighters[meIdx];
              const p = pendingTickRef.current;
              if (mine) {
                setPendingWeapon((w) =>
                  w !== null && (mine.weapon === w || s.tick - p.w >= 2) ? null : w
                );
                setPendingEat((e) =>
                  e &&
                  (s.events.some((ev) => ev.actor === meIdx && ev.kind === "eat") ||
                    s.tick - p.e >= 2)
                    ? false
                    : e
                );
                setPendingSpec((sp) =>
                  sp &&
                  (mine.specArmed ||
                    s.events.some(
                      (ev) =>
                        ev.actor === meIdx &&
                        (ev.kind === "spec-hit" || ev.kind === "spec-miss")
                    ) ||
                    s.tick - p.s >= 2)
                    ? false
                    : sp
                );
              }
            }
            break;
          }
          case "end": {
            const v = {
              winner: Number(msg.winner),
              reason: String(msg.reason),
              dmg: (msg.dmg ?? [0, 0]) as [number, number],
            };
            verdictRef.current = v;
            const wager = Number(msg.wager) || 0;
            setResultPot(
              wager > 0
                ? { wager, pot: Number(msg.pot) || 0, winner: v.winner }
                : null
            );
            // a wagered fight moved the wallet — pull the fresh balance and
            // tell the header wallet to update too (dispatch refetches it)
            if (wager > 0) {
              refreshBalance();
              window.dispatchEvent(
                new CustomEvent(COIN_BALANCE_EVENT, { detail: null })
              );
            }
            setPeerBlip(false);
            setPhase("result");
            sfx.die();
            break;
          }
          case "peer-blip":
            setPeerBlip(true);
            break;
          case "peer-left":
            setPeerBlip(false);
            setPhase("waiting");
            break;
          case "error":
            fail(String(msg.msg ?? "the pit rejected you"));
            break;
        }
      };
      ws.onclose = () => {
        const ph = phaseRef.current;
        if (!opened) {
          // the http side answered but nothing owns /arena — this server
          // isn't running the realtime hub (dev: npm run dev:live)
          fail(
            "couldn't reach the live arena — this server isn't running the realtime hub"
          );
        } else if (ph === "fight" || ph === "countdown") {
          fail("connection lost — the fight was forfeited");
        } else if (ph === "waiting" && stashedPit()) {
          // the socket died under a waiting pit (sleep, blip, dev reload) —
          // the hub benches the seat and unlists the pit, so a pill left
          // standing would be a lie. give the blip a beat, then walk back
          // in and reclaim. every deliberate exit clears the stash first,
          // so this only fires on drops nobody asked for.
          setTimeout(async () => {
            if (teardownRef.current || wsRef.current !== ws) return;
            const code = stashedPit();
            if (!code) return;
            try {
              // the old ticket may have aged out (10-minute HMAC) while
              // the pit waits up to 30 — mint a fresh one before knocking
              const got = await fetchTicket();
              if (teardownRef.current || wsRef.current !== ws) return;
              if (!got.ok) return fail(got.error);
              ticketRef.current = got.ticket;
              connectRef.current({ t: "join", code });
            } catch {
              fail("network hiccup — try again");
            }
          }, 1000);
        }
      };
    },
    [nickname, xHandle, fail, entry.kind, refreshBalance]
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // ---- ticket, then socket ----------------------------------------------

  useEffect(() => {
    let closed = false;
    teardownRef.current = false;
    (async () => {
      try {
        const got = await fetchTicket();
        if (!got.ok) return fail(got.error);
        if (closed) return;
        ticketRef.current = got.ticket;
        setXHandle(got.handle);
        if (got.handle) {
          // a linked X account is a ready-made sparring name too — prefill,
          // never override a name the bird already answers to
          const asNick = got.handle
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, "")
            .slice(0, 12);
          if (asNick.length >= 3) setNickname((prev) => prev || asNick);
        }
        // dev fast-refresh re-runs this effect and its cleanup closed the
        // socket mid-wait — a seated pit walks back in instead of being
        // reset to the entry screen (refs survive the refresh, so a held
        // room is exactly gotRoom + a stash)
        const held = gotRoomRef.current ? stashedPit() : "";
        if (held) {
          setPhase("waiting");
          connect({ t: "join", code: held });
          return;
        }
        setPhase(
          entry.kind === "create" ? "options" : entry.kind === "join" ? "code" : "waiting"
        );
        if (entry.kind === "bot") setPhase("options");
        if (entry.kind === "spectate") connect({ t: "spectate", code: entry.code });
        // reclaiming our own pit — no code screen, straight through the door
        if (entry.kind === "rejoin") connect({ t: "join", code: entry.code });
      } catch {
        fail("network hiccup — try again");
      }
    })();
    return () => {
      closed = true;
      teardownRef.current = true;
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const saveName = useCallback(() => {
    try {
      localStorage.setItem("fb_duel_name", nickname.trim().toUpperCase());
    } catch {
      // fine
    }
  }, [nickname]);

  // ---- intents -----------------------------------------------------------

  const intent = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && phaseRef.current === "fight") {
      ws.send(JSON.stringify({ t: "intent", ...payload }));
    }
  }, []);

  // every combat input goes through a press* wrapper: fire the intent AND
  // acknowledge it on the spot (echo + click) instead of leaving the button
  // dark until the tick round-trips
  const pressWeapon = useCallback(
    (wi: number) => {
      pendingTickRef.current.w = snapRef.current?.tick ?? 0;
      setPendingWeapon(wi);
      intent({ weapon: wi });
      sfx.pop();
    },
    [intent]
  );
  const pressEat = useCallback(() => {
    pendingTickRef.current.e = snapRef.current?.tick ?? 0;
    setPendingEat(true);
    intent({ eat: true });
    sfx.pop();
  }, [intent]);
  const pressSpec = useCallback(() => {
    pendingTickRef.current.s = snapRef.current?.tick ?? 0;
    setPendingSpec(true);
    intent({ spec: true });
    sfx.pop();
  }, [intent]);

  // the site chat lives at z-40, under this modal's z-50 scrim — flag the
  // body while the pit is actually covering the screen so ChatPanel can lift
  // itself above it and stay usable mid-duel
  useEffect(() => {
    if (minimized) return;
    document.body.classList.add("arena-open");
    return () => document.body.classList.remove("arena-open");
  }, [minimized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== "fight" || e.repeat) return;
      // chat floats over the pit: keystrokes aimed at its composer are
      // words, not weapon switches
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      switch (e.code) {
        case "Digit1":
        case "Digit2":
        case "Digit3":
        case "Digit4":
        case "Digit5":
        case "Digit6": {
          // digits address the fight's rack, not the full armory — in a
          // whip-only pit there's exactly one slot and it's key 1
          const wi = options.weapons[Number(e.code.slice(-1)) - 1];
          if (wi !== undefined) pressWeapon(wi);
          break;
        }
        case "KeyE":
          pressEat();
          break;
        case "KeyF":
          pressSpec();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pressWeapon, pressEat, pressSpec, options.weapons]);

  // ---- render loop -------------------------------------------------------

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const loop = (now: number) => {
      const v = verdictRef.current;
      const n = namesRef.current;
      let banner: string | null = null;
      let sub: string | null = null;
      if (v && (phaseRef.current === "result" || phaseRef.current === "error")) {
        banner =
          v.winner === 2
            ? "DRAW!"
            : v.winner === youAreRef.current
              ? "YOU TAKE IT"
              : `${n[v.winner] ?? "THEY"} TAKES IT`;
        sub =
          v.reason === "ko"
            ? `K.O. — damage ${v.dmg[0]} / ${v.dmg[1]}`
            : v.reason === "forfeit"
              ? "opponent fled the pit"
              : `time! — damage ${v.dmg[0]} / ${v.dmg[1]}`;
      }
      drawArena(ctx, {
        now,
        swings: swingsRef.current,
        clickedEngage: clickedEngageRef.current,
        snap: snapRef.current,
        names: n,
        youAre: youAreRef.current,
        countdown: countdownRef.current,
        splats: splatsRef.current,
        banner,
        subBanner: sub,
        tickMs: TICK_MS,
        lastTickAt: lastTickAtRef.current,
      });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ---- chrome ------------------------------------------------------------

  const optionChips = (o: ArenaOptions) => {
    const chips: string[] = [];
    // the stake leads — it's the term that matters most across the pit
    if (o.wager > 0) chips.push(`🪙 ${o.wager} stake — winner takes ${o.wager * 2}`);
    if (o.noFood) chips.push("no food");
    if (o.noSpec) chips.push("no spec");
    if (o.weapons.length < WEAPONS.length) {
      chips.push(`${o.weapons.map((i) => WEAPONS[i].key).join(" + ")} only`);
    }
    return chips;
  };

  const me = snap?.fighters[youAre];
  // what the rack should light up: your press the instant you make it,
  // the server's word once it lands
  const heldWeapon = pendingWeapon ?? me?.weapon;

  // minimized: the pit stays open on this socket, the board shows through.
  // display:none (not unmount) keeps the canvas + render loop alive; the
  // pill reopens the modal, and review reopens it on its own the moment a
  // challenger steps in.
  return (
    <>
      {minimized && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-stretch gap-2 max-w-[calc(100vw-2rem)]">
          <button
            onClick={() => setMinimized(false)}
            className="pixel-btn bg-gold font-pixel text-[9px] px-4 py-3 animate-pulse min-w-0"
          >
            <span className="block truncate">
              ⚔ PIT {roomCode} — waiting for a challenger…
            </span>
            {expiresAt && (
              <PitTimer
                expiresAt={expiresAt}
                className="block text-[8px] text-ink/70 mt-1"
              />
            )}
          </button>
          <ShareLink
            code={roomCode}
            compact
            className="pixel-btn bg-orange text-white font-pixel text-[9px] px-4 py-3 shrink-0"
          />
          <button
            onClick={() => {
              wsRef.current?.send(JSON.stringify({ t: "leave" }));
              clearPit();
              onClose();
            }}
            aria-label="Cancel pit"
            className="pixel-btn bg-paper font-pixel text-[9px] px-3 py-3 shrink-0 hover:text-orange-deep"
          >
            ✕
          </button>
        </div>
      )}
    <div className={`fixed inset-0 z-50 bg-scrim/60 overscroll-contain sm:items-center sm:justify-center sm:p-4 ${minimized ? "hidden" : "flex"}`}>
      <div className="bg-paper flex flex-col w-full h-[100dvh] overflow-hidden sm:h-[min(860px,94dvh)] sm:max-w-[560px] sm:border-4 sm:border-ink sm:shadow-[6px_6px_0_rgba(0,0,0,0.35)]">
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-sand border-b-4 border-ink pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-base leading-none text-muted">live arena</p>
            <p className="font-pixel text-[11px] truncate mt-1.5">
              {phase === "fight" || phase === "countdown" || phase === "result"
                ? `${names[0]} vs ${names[1]}`
                : entry.kind === "spectate"
                  ? "RINGSIDE"
                  : entry.kind === "bot"
                    ? "SPARRING THE PIT BOT"
                  : roomCode
                    ? `PIT ${roomCode}`
                    : "THE PIT"}
            </p>
          </div>
          <div className="flex items-center">
            {phase === "waiting" && roomCode && (
              // back to the pill — the pit keeps waiting under the board
              <button
                onClick={() => setMinimized(true)}
                className="font-pixel text-sm px-3 py-2 hover:text-orange-deep"
                aria-label="Minimize"
              >
                _
              </button>
            )}
            <button
              onClick={() => {
                wsRef.current?.send(JSON.stringify({ t: "leave" }));
                clearPit();
                onClose();
              }}
              className="font-pixel text-sm px-3 py-2 -mr-2 hover:text-orange-deep"
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>

        <div className="relative flex-1 min-h-0 bg-scrim flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            onPointerDown={(e) => {
              if (phaseRef.current !== "fight") return;
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
              const y = ((e.clientY - rect.top) / rect.height) * HEIGHT;
              // your opponent renders on the right when you're seat 0's
              // perspective — the hitbox helper mirrors with you
              const opp = birdHitbox(1);
              if (
                x >= opp.x - 12 &&
                x <= opp.x + opp.w + 12 &&
                y >= opp.y - 12 &&
                y <= opp.y + opp.h + 12
              ) {
                clickedEngageRef.current = true; // once is enough — forever
                intent({ engage: true });
                sfx.shoot();
              }
            }}
            className="block touch-none select-none cursor-pointer max-w-full max-h-full"
          />

          {(phase === "gate" || phase === "waiting") && (
            <Overlay>
              <div className="text-center px-6">
                {phase === "waiting" && roomCode ? (
                  <>
                    <p className="font-pixel text-lg text-gold text-outline mb-3">
                      PIT {roomCode}
                    </p>
                    <p className="text-xl text-white text-outline mb-2">
                      waiting for a challenger…
                    </p>
                    <p className="text-lg text-white/80 text-outline">
                      send the link to anyone — one click and they&apos;re in
                    </p>
                    <ShareLink code={roomCode} />
                    <div className="mt-3">
                      <button
                        onClick={() => {
                          wsRef.current?.send(JSON.stringify({ t: "leave" }));
                          clearPit();
                          onClose();
                        }}
                        className="pixel-btn bg-paper font-pixel text-[9px] px-4 py-3"
                      >
                        ✕ CANCEL PIT
                      </button>
                    </div>
                    {expiresAt ? (
                      <PitTimer
                        expiresAt={expiresAt}
                        className="block font-pixel text-[9px] text-white/70 text-outline mt-3"
                      />
                    ) : (
                      <p className="text-sm text-white/60 text-outline mt-3">
                        an unanswered pit closes on its own after 30 minutes
                      </p>
                    )}
                  </>
                ) : (
                  <p className="font-pixel text-[10px] text-white text-outline">
                    {phase === "gate" ? "checking you at the gate…" : "entering the pit…"}
                  </p>
                )}
              </div>
            </Overlay>
          )}

          {phase === "options" && (
            <Overlay>
              {/* the bot screen is the PvP flow squeezed into one stop:
                  terms, name, go — no opponent to wait on, no READY lock.
                  everything sits on one sand panel — an interface, not
                  captions floating over the arena wall */}
              <div className="w-full max-h-full py-4 px-3 flex justify-center">
                {/* a flex column: the terms scroll in the body while the
                    identity line and the go button stay pinned below, so the
                    primary action never drops off a short screen */}
                <div className="flex flex-col max-h-full w-full max-w-[420px] bg-sand border-4 border-ink shadow-[6px_6px_0_rgba(0,0,0,0.45)] text-center">
                  <div className="min-h-0 overflow-y-auto px-4 pt-4 pb-3">
                  <p className="font-pixel text-sm mb-1">SET YOUR TERMS</p>
                  {/* the rules, stated in the positive — gold means it's in
                      the fight, paper means it's barred at the gate */}
                  <p className="text-base text-muted mb-3">
                    gold is in the fight — paper sits out
                  </p>
                  <div className="flex justify-center gap-2 mb-4">
                    <button
                      onClick={() => setOptions((o) => ({ ...o, noFood: !o.noFood }))}
                      className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                        options.noFood ? "bg-paper" : "bg-gold"
                      }`}
                    >
                      {options.noFood ? "🍗 NO FOOD" : "🍗 FOOD IN"}
                    </button>
                    <button
                      onClick={() => setOptions((o) => ({ ...o, noSpec: !o.noSpec }))}
                      className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                        options.noSpec ? "bg-paper" : "bg-gold"
                      }`}
                    >
                      {options.noSpec ? "⚡ NO SPECS" : "⚡ SPECS IN"}
                    </button>
                  </div>
                  {/* the rack: tap a weapon out of the fight — whip-only
                      duels welcome. at least one blade stays. */}
                  <div className="border-t-2 border-ink/15 pt-3">
                    <p className="font-pixel text-[10px] mb-1">THE RACK</p>
                    <p className="text-base text-muted mb-2">
                      tap a weapon out of the duel — at least one stays
                    </p>
                    <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                      {WEAPONS.map((w, i) => {
                        const on = options.weapons.includes(i);
                        return (
                          <button
                            key={w.key}
                            onClick={() =>
                              setOptions((o) => {
                                const has = o.weapons.includes(i);
                                if (has && o.weapons.length === 1) return o;
                                return {
                                  ...o,
                                  weapons: has
                                    ? o.weapons.filter((x) => x !== i)
                                    : [...o.weapons, i].sort((a, b) => a - b),
                                };
                              })
                            }
                            title={`${w.label} — ${w.bonus}`}
                            className={`pixel-btn px-1 pt-1.5 pb-1.5 ${
                              on ? "bg-gold" : "bg-paper opacity-40"
                            }`}
                          >
                            <WeaponIcon k={w.key} big />
                            {/* .pixel-btn forces the wide press-start face on
                                everything inside — the stat line opts back
                                into the narrow terminal font or it clips */}
                            <span className="block font-pixel text-[7px] mt-1 leading-[1.7] min-h-[24px]">
                              {w.label}
                            </span>
                            <span className="block font-sans text-base leading-none text-ink/60 whitespace-nowrap">
                              {w.max} · {w.speed}t · {Math.round(w.acc * 100)}%
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-sm text-muted mb-4">
                      max hit · ticks a swing · accuracy
                    </p>
                  </div>
                  {/* the stakes: coins on the line, winner takes the pot.
                      PvP only — the bot never plays for money. */}
                  {entry.kind === "create" && (
                    <StakePicker
                      wager={options.wager}
                      balance={balance}
                      connected={xHandle !== null}
                      onPick={(w) => setOptions((o) => ({ ...o, wager: w }))}
                    />
                  )}
                  </div>
                  {/* pinned footer — identity, listing, and the go button
                      never scroll out of reach */}
                  <div className="shrink-0 border-t-2 border-ink/25 px-4 pt-3.5 pb-4">
                  {entry.kind === "bot" ? (
                    <NickField value={nickname} onChange={setNickname} />
                  ) : (
                    <XSeat handle={xHandle} next="/duels" onPanel />
                  )}
                  {entry.kind === "create" && (
                    <button
                      onClick={() => setListed((l) => !l)}
                      className={`pixel-btn font-pixel text-[9px] px-3 py-2 mb-4 ${
                        listed ? "bg-paper" : "bg-gold"
                      }`}
                    >
                      {listed ? "listed on the board" : "✓ private — code only"}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      saveName();
                      connect(
                        entry.kind === "bot"
                          ? { t: "bot", options }
                          : { t: "create", options, listed }
                      );
                    }}
                    disabled={
                      !canStart ||
                      (entry.kind === "create" && options.wager > balance)
                    }
                    className="pixel-btn bg-orange text-white font-pixel text-xs w-full px-6 py-3 disabled:opacity-40"
                  >
                    {entry.kind === "create" && options.wager > 0
                      ? `⚔ OPEN THE PIT · 🪙 ${options.wager}`
                      : entry.kind === "bot"
                        ? "🥊 SPAR THE BOT"
                        : "⚔ OPEN THE PIT"}
                  </button>
                  </div>
                </div>
              </div>
            </Overlay>
          )}

          {phase === "code" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-lg text-gold text-outline mb-3">
                  JOIN A PIT
                </p>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="CODE"
                  maxLength={4}
                  className="border-4 border-ink bg-paper px-3 py-2 text-center font-pixel text-sm mb-3 w-36 block mx-auto tracking-widest"
                />
                <XSeat
                  handle={xHandle}
                  next={code.length === 4 ? `/duels/${code}` : "/duels"}
                />
                <button
                  onClick={() => {
                    saveName();
                    connect({ t: "join", code });
                  }}
                  disabled={!canStart || code.length !== 4}
                  className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-3 disabled:opacity-40"
                >
                  ⚔ STEP IN
                </button>
              </div>
            </Overlay>
          )}

          {phase === "review" && (
            <Overlay>
              <div className="text-center px-6 max-h-full overflow-y-auto py-4">
                <p className="font-pixel text-base text-gold text-outline mb-2">
                  {names[0]} vs {names[1]}
                </p>
                <p className="text-xl text-white text-outline mb-2">the terms:</p>
                <p className="font-pixel text-[10px] text-white text-outline mb-4">
                  {optionChips(options).length
                    ? optionChips(options).join(" · ")
                    : "everything allowed"}
                </p>
                {options.wager > 0 && (
                  <div className="bg-scrim/50 border-2 border-gold px-4 py-3 mb-3">
                    <p className="font-pixel text-[11px] text-gold text-outline">
                      🪙 {options.wager} ON THE LINE
                    </p>
                    <p className="text-lg text-white/90 text-outline mt-1">
                      both stake {options.wager} — winner takes {options.wager * 2}.
                      readying up locks your coins.
                    </p>
                    <p
                      className={`text-base text-outline mt-1 ${
                        balance < options.wager ? "text-red" : "text-white/70"
                      }`}
                    >
                      your wallet: {balance} 🪙
                      {balance < options.wager && " — not enough for this stake"}
                    </p>
                  </div>
                )}
                <p className="text-lg text-white/80 text-outline mb-3">
                  all melee, switch freely mid-fight — every weapon averages
                  the same damage, fast pecks or slow spikes, never an edge.
                  after the count the fight starts on its own. KO wins.
                </p>
                <button
                  onClick={() => {
                    wsRef.current?.send(JSON.stringify({ t: "accept" }));
                  }}
                  disabled={readyPair[youAre] || balance < options.wager}
                  className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-3 disabled:opacity-60"
                >
                  {readyPair[youAre]
                    ? "✓ READY"
                    : balance < options.wager
                      ? "🪙 NOT ENOUGH COINS"
                      : options.wager > 0
                        ? `⚔ READY UP · STAKE 🪙 ${options.wager}`
                        : "⚔ READY UP"}
                </button>
                <p className="font-pixel text-[9px] text-white text-outline mt-4">
                  {readyPair[youAre] ? "you: ready ✓" : "you: not ready"}
                  {" · "}
                  {readyPair[1 - youAre]
                    ? `${names[1 - youAre] || "opponent"}: ready ✓`
                    : `waiting for ${names[1 - youAre] || "opponent"}…`}
                </p>
              </div>
            </Overlay>
          )}

          {peerBlip && phase === "fight" && (
            <div className="absolute top-14 left-0 right-0 text-center">
              <span className="font-pixel text-[9px] bg-red text-white px-3 py-2">
                opponent connection wobbling…
              </span>
            </div>
          )}

          {phase === "result" && (
            <div className="absolute bottom-3 left-0 right-0 flex flex-col items-center gap-3">
              {resultPot && (
                <div className="bg-scrim/70 border-2 border-ink px-4 py-2">
                  {resultPot.winner === 2 ? (
                    <p className="font-pixel text-[10px] text-white text-outline">
                      🪙 draw — your {resultPot.wager} stake is back
                    </p>
                  ) : resultPot.winner === youAre ? (
                    <p className="font-pixel text-[11px] text-gold text-outline">
                      🪙 +{resultPot.wager} — you took the {resultPot.pot} pot
                    </p>
                  ) : (
                    <p className="font-pixel text-[10px] text-red text-outline">
                      🪙 −{resultPot.wager} — the pot went the other way
                    </p>
                  )}
                </div>
              )}
              <button
                onClick={onClose}
                className="pixel-btn bg-orange text-white font-pixel text-[10px] px-5 py-3"
              >
                DONE
              </button>
            </div>
          )}

          {phase === "error" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-sm text-red text-outline mb-4">{errorMsg}</p>
                <button
                  onClick={onClose}
                  className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
                >
                  CLOSE
                </button>
              </div>
            </Overlay>
          )}
        </div>

        {phase === "fight" && me && entry.kind !== "spectate" && (
          <div className="shrink-0 bg-sand border-t-4 border-ink px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {/* the hotbar: every slot wears its own key — number for the
                rack, E and F for the belt — so no legend line is needed */}
            <div className="flex justify-center gap-1.5 mb-1.5">
              {/* only this fight's rack — banned weapons don't render */}
              {options.weapons.map((wi, pos) => {
                const w = WEAPONS[wi];
                return (
                  <button
                    key={w.key}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      pressWeapon(wi);
                    }}
                    title={`${w.label} — ${w.bonus}`}
                    className={`pixel-btn flex-1 max-w-[92px] min-w-0 px-1 pt-1 pb-1.5 touch-none select-none ${
                      heldWeapon === wi ? "bg-gold" : "bg-paper"
                    } ${pendingWeapon === wi && me.weapon !== wi ? "animate-pulse" : ""}`}
                  >
                    <span className="block text-sm leading-none text-ink/50">
                      {pos + 1}
                    </span>
                    <WeaponIcon k={w.key} />
                    <span className="block font-pixel text-[7px] mt-0.5 truncate">
                      {w.short}
                    </span>
                  </button>
                );
              })}
            </div>
            {(!options.noFood || !options.noSpec) && (
              <div className="flex justify-center gap-1.5">
                {!options.noFood && (
                  <button
                    onPointerDown={(e) => {
                      e.preventDefault();
                      pressEat();
                    }}
                    disabled={me.berries === 0}
                    className={`pixel-btn w-28 px-1 py-1.5 touch-none select-none disabled:opacity-40 ${
                      pendingEat ? "bg-gold animate-pulse" : "bg-paper"
                    }`}
                  >
                    <span className="block text-sm leading-none text-ink/50">
                      E
                    </span>
                    <span className="block font-pixel text-[8px] mt-1">
                      🫐 ×{me.berries}
                    </span>
                  </button>
                )}
                {!options.noSpec && (
                  <button
                    onPointerDown={(e) => {
                      e.preventDefault();
                      pressSpec();
                    }}
                    disabled={me.specEnergy < 50}
                    className={`pixel-btn w-28 px-1 py-1.5 touch-none select-none disabled:opacity-40 ${
                      me.specArmed || pendingSpec
                        ? "bg-red text-white"
                        : me.specEnergy >= 50
                          ? "bg-gold"
                          : "bg-paper"
                    } ${pendingSpec && !me.specArmed ? "animate-pulse" : ""}`}
                  >
                    <span
                      className={`block text-sm leading-none ${
                        me.specArmed || pendingSpec ? "text-white/70" : "text-ink/50"
                      }`}
                    >
                      F
                    </span>
                    <span className="block font-pixel text-[8px] mt-1">
                      SPEC {me.specEnergy}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/** the PvP seat: duels are X-gated, so either "you fight as @handle" or the
 *  OAuth on-ramp, which round-trips and lands back on `next` */
function XSeat({
  handle,
  next,
  onPanel = false,
}: {
  handle: string | null;
  next: string;
  /** sitting on a sand panel: ink text, no white outline */
  onPanel?: boolean;
}) {
  if (handle) {
    return (
      <p
        className={`font-pixel text-[9px] mb-4 ${
          onPanel ? "" : "text-white text-outline"
        }`}
      >
        𝕏 verified — you fight as @{handle}
      </p>
    );
  }
  return (
    <div className="mb-4">
      <p
        className={`text-lg mb-2 ${
          onPanel ? "text-muted" : "text-white/80 text-outline"
        }`}
      >
        duels are 𝕏-verified — one account, one bird on the board. wins are
        +1, losses −1, and your score never drops below 0.
      </p>
      <a
        href={`/api/x/connect?next=${encodeURIComponent(next)}`}
        className="pixel-btn bg-gold font-pixel text-[9px] px-4 py-3 inline-block"
      >
        𝕏 CONNECT TO FIGHT
      </a>
    </div>
  );
}

/** the challenge link, one tap to copy — no share sheet in the way */
function ShareLink({
  code,
  compact = false,
  className = "pixel-btn bg-gold font-pixel text-[9px] px-4 py-3 mt-4",
}: {
  code: string;
  compact?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${location.origin}/duels/${code}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // clipboard blocked: the code on screen still works
        }
      }}
      className={className}
    >
      {copied
        ? compact
          ? "✓ COPIED"
          : "✓ LINK COPIED"
        : compact
          ? "🔗 COPY"
          : "🔗 COPY CHALLENGE LINK"}
    </button>
  );
}

/** the open-pit countdown: an abandoned pit auto-closes after the server's
 *  30-minute TTL, so the host can see how long the seat stays open. ticks
 *  once a second; reads "closes in mm:ss", then "closing…" at zero. */
function PitTimer({
  expiresAt,
  className = "",
}: {
  expiresAt: number;
  className?: string;
}) {
  const [left, setLeft] = useState(() => expiresAt - Date.now());
  useEffect(() => {
    const tick = () => setLeft(expiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (left <= 0)
    return <span className={className}>closing…</span>;
  const total = Math.ceil(left / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return (
    <span className={className}>
      closes in {mm}:{String(ss).padStart(2, "0")}
    </span>
  );
}

/** a little pixel portrait of a rack weapon — the same code sprite the
 *  fight draws, rendered once into a crisp doubled-up canvas. `big` is the
 *  rack-card size; the default fits inline chips. */
function WeaponIcon({ k, big = false }: { k: string; big?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = big ? 168 : 104;
  const h = big ? 76 : 48;
  const s = big ? 2.9 : 1.8;
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(c.width / 2, c.height / 2);
    ctx.scale(s, s);
    drawWeaponIcon(ctx, k);
    ctx.restore();
  }, [k, s]);
  return (
    <canvas
      ref={ref}
      width={w}
      height={h}
      className="mx-auto"
      // height auto + max-width keeps the sprite in ratio when a narrow
      // hotbar slot squeezes below the sprite's natural size
      style={{
        width: w / 2,
        maxWidth: "100%",
        height: "auto",
        imageRendering: "pixelated",
      }}
    />
  );
}

/** preset stakes, in coins (~50 = $1). 0 is a friendly, no-stakes fight. */
const STAKE_PRESETS = [0, 50, 100, 250, 500];

/** the wager picker on the create screen: pick a preset or type a custom
 *  stake. The escrow is the real gate — this just keeps the host from opening
 *  a pit they can't cover, and states the terms in coins. PvP only. */
function StakePicker({
  wager,
  balance,
  connected,
  onPick,
}: {
  wager: number;
  balance: number;
  connected: boolean;
  onPick: (w: number) => void;
}) {
  // custom holds the typed digits; while it's non-empty the presets don't
  // claim the highlight (the field owns the value)
  const [custom, setCustom] = useState("");
  return (
    <div className="border-t-2 border-ink/15 pt-3 mb-4">
      <p className="font-pixel text-[10px] mb-1">THE STAKE</p>
      <p className="text-base text-muted mb-2">
        coins on the line — both stake the same, winner takes the pot
      </p>
      <div className="flex flex-wrap justify-center gap-1.5 mb-2">
        {STAKE_PRESETS.map((v) => (
          <button
            key={v}
            onClick={() => {
              setCustom("");
              onPick(v);
            }}
            className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
              wager === v && custom === "" ? "bg-gold" : "bg-paper"
            }`}
          >
            {v === 0 ? "FRIENDLY" : `🪙 ${v}`}
          </button>
        ))}
      </div>
      <input
        value={custom}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 6);
          setCustom(digits);
          onPick(Math.min(Number(digits) || 0, MAX_WAGER));
        }}
        inputMode="numeric"
        placeholder="custom amount"
        className="border-4 border-ink bg-paper px-3 py-2 text-center font-pixel text-[9px] w-40 block mx-auto mb-2"
      />
      {connected ? (
        <p className={`text-base ${wager > balance ? "text-red" : "text-muted"}`}>
          your wallet: {balance} 🪙
          {wager > 0 && wager <= balance && ` · winner takes ${wager * 2}`}
          {wager > balance && " · not enough — top up in the header wallet"}
        </p>
      ) : (
        <p className="text-base text-muted">connect 𝕏 to stake coins</p>
      )}
    </div>
  );
}

function NickField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
      placeholder="YOUR BIRD NAME"
      maxLength={12}
      className="border-4 border-ink bg-paper px-3 py-2 text-center font-pixel text-[10px] mb-4 w-52 block mx-auto"
    />
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-scrim/50">
      {children}
    </div>
  );
}
