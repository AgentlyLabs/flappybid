// The live arena hub: rooms, the authoritative 600ms tick loop, and the
// anti-bot bookkeeping. Clients never run the fight — they send intents
// and render whatever the server broadcasts. At fight end everyone gets
// the seed + full intent log, so any verdict can be re-simulated with
// arenaReplay by anyone who cares to check (the audit trail stakes would
// settle against).
//
// Entry is gated: the ws join must carry a ticket minted by
// /api/arena/ticket, which sits behind the same origin/rate/Turnstile/ban
// stack as run starts. PvP seats need the ticket to carry a verified X
// handle (throwaway browsers would farm the duel board otherwise); the bot
// and ringside stay open to everyone. The hub's one database touch is the
// fire-and-forget win ledger write at fight end (duel_wins — the daily
// duel board's +1); everything else stays in memory.

import { createHmac, randomInt, timingSafeEqual } from "crypto";
import type { Server } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ARENA_VERSION,
  COUNTDOWN_TICKS,
  TICK_MS,
  arenaSnapshot,
  createArena,
  normalizeArenaOptions,
  stepArena,
  type ArenaIntent,
  type ArenaLog,
  type ArenaOptions,
  type ArenaState,
} from "../game/arena";
import { mulberry32 } from "../game/rng";
import { recordDuelWin } from "../lib/duelBoard";
import {
  openDuelWager,
  settleDuelWager,
  refundDuelWager,
  refundStaleWagers,
} from "../lib/wager";

// -- tickets ----------------------------------------------------------------

function ticketKey(): string {
  return (
    "fb-arena:" + (process.env.CRON_SECRET ?? process.env.IP_HASH_SALT ?? "flappybid")
  );
}

/** handle is the browser's verified X handle, "" when unlinked — signed
 *  into the ticket so the hub can gate PvP without a DB lookup */
export function mintArenaTicket(ipHash: string, handle = ""): string {
  const exp = Date.now() + 10 * 60 * 1000;
  const mac = createHmac("sha256", ticketKey())
    .update(`${exp}.${ipHash}.${handle}`)
    .digest("hex")
    .slice(0, 32);
  return `${exp}.${ipHash}.${handle}.${mac}`;
}

interface TicketAuth {
  ipHash: string;
  /** verified X handle, exact case; "" = not linked */
  handle: string;
}

function readTicket(value: unknown): TicketAuth | null {
  if (typeof value !== "string") return null;
  const [expStr, ipHash, handle, mac] = value.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !ipHash || mac === undefined) {
    return null;
  }
  const expect = createHmac("sha256", ticketKey())
    .update(`${exp}.${ipHash}.${handle}`)
    .digest("hex")
    .slice(0, 32);
  const a = Buffer.from(expect);
  const b = Buffer.from(mac);
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ipHash, handle }
    : null;
}

// -- rooms ------------------------------------------------------------------

interface Slot {
  ws: WebSocket | null;
  nickname: string;
  /** verified X handle, exact case; "" for the bot (PvP seats always have one) */
  handle: string;
  ipHash: string;
  accepted: boolean;
  intents: number; // total intent messages, for rate sanity
}

interface Room {
  code: string;
  /** shows on the open-pits board (private pits share by code only) */
  listed: boolean;
  /** seat 1 is the server's practice bot — no socket, no stakes ever */
  bot: boolean;
  botRng: (() => number) | null;
  options: ArenaOptions;
  players: [Slot | null, Slot | null];
  /** "locking" sits between review and countdown: both readied up and the
   *  coin escrow is in flight (only for a wagered pit) */
  phase: "waiting" | "review" | "locking" | "countdown" | "fight" | "done";
  state: ArenaState | null;
  seed: number;
  log: ArenaLog;
  pending: [ArenaIntent, ArenaIntent];
  /** who actually fought, frozen at countdown — a forfeiter's seat empties
   *  before endFight, but their identity still owes the ledger a loser */
  fightIds: [{ handle: string; ip: string }, { handle: string; ip: string }] | null;
  /** the coin escrow locked at the bell, settled to the
   *  winner or refunded at endFight; null for friendly and bot pits */
  wagerId: string | null;
  spectators: WebSocket[];
  timer: ReturnType<typeof setInterval> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  reviewTimer: ReturnType<typeof setTimeout> | null;
  /** the pit belongs to this X handle ("" for bot spars) — one open
   *  challenge per bird, and the challenge outlives its socket: the same
   *  handle reclaims seat 0 after a refresh, a new tab, or a wander */
  hostHandle: string;
  createdAt: number;
}

const NICK_RE = /^[A-Z0-9_-]{3,12}$/;
/** both sides must ready up within this window once a challenger arrives */
const REVIEW_TIMEOUT_MS = 45_000;
const MAX_ROOMS = 200;
/** a pit that never found (or never started) its fight auto-cancels here */
const ROOM_TTL_MS = 30 * 60 * 1000;
const FORFEIT_GRACE_MS = 10_000;

export function attachArenaHub(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://x").pathname;
    } catch {
      // fall through — not ours
    }
    if (pathname !== "/arena") return; // Next handles its own upgrades
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const roomSend = (room: Room, msg: unknown) => {
    for (const p of room.players) if (p?.ws) send(p.ws, msg);
    for (const w of room.spectators) send(w, msg);
  };

  function makeCode(): string {
    let code = "";
    do {
      code = Array.from({ length: 4 }, () =>
        "ABCDEFGHJKMNPQRSTVWXYZ23456789".charAt(randomInt(30))
      ).join("");
    } while (rooms.has(code));
    return code;
  }

  function destroyRoom(room: Room) {
    if (room.timer) clearInterval(room.timer);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    if (room.reviewTimer) clearTimeout(room.reviewTimer);
    // safety net: a room going away with coins still escrowed (a path that
    // tore the pit down without a verdict) refunds both sides. Settled/aborted
    // wagers already nulled this, and the RPC is idempotent, so a double can't
    // pay twice.
    if (room.wagerId) {
      const wid = room.wagerId;
      room.wagerId = null;
      refundDuelWager(wid).catch(() => {});
    }
    rooms.delete(room.code);
  }

  function endFight(room: Room, winner: number, reason: string) {
    if (room.phase === "done") return;
    room.phase = "done";
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    const st = room.state;
    // the duel board's +1: PvP only, decisive only, and never for beating
    // yourself — same-IP and same-handle pairings fight for fun but score
    // nothing (the in-band audit already tags them sameIdentity)
    const ids = room.fightIds;
    if (!room.bot && ids && (winner === 0 || winner === 1)) {
      const w = ids[winner];
      const l = ids[1 - winner];
      if (
        w.handle &&
        l.handle &&
        w.handle.toLowerCase() !== l.handle.toLowerCase() &&
        w.ip !== l.ip
      ) {
        recordDuelWin({
          handle: w.handle,
          opponent: l.handle,
          code: room.code,
          reason,
          ticks: st?.tick ?? 0,
          ipHash: w.ip || null,
        }).catch(() => {
          // the fight's verdict was already broadcast; a lost ledger row
          // must never take the room down with it
        });
      }
    }
    // settle the coin pot: a decisive verdict (ko/time/forfeit → winner 0 or 1)
    // pays the winner 2×; a draw refunds both. Null the id first so the
    // destroyRoom safety net can't fire a second (idempotent) refund on top.
    const wid = room.wagerId;
    room.wagerId = null;
    let potWon = 0;
    if (wid) {
      if ((winner === 0 || winner === 1) && ids && ids[winner].handle) {
        potWon = room.options.wager * 2;
        settleDuelWager(wid, ids[winner].handle);
      } else {
        refundDuelWager(wid);
      }
    }
    roomSend(room, {
      t: "end",
      winner,
      reason,
      // stakes: the pot the winner takes (0 for a friendly or a draw) — the
      // client shows the coin swing and refreshes the header wallet
      wager: room.options.wager,
      pot: potWon,
      hp: st ? [st.fighters[0].hp, st.fighters[1].hp] : [0, 0],
      dmg: st ? [st.fighters[0].dmgDealt, st.fighters[1].dmgDealt] : [0, 0],
      // the audit bundle: anyone can re-run arenaReplay(seed, options, log)
      seed: room.seed,
      options: room.options,
      log: room.log,
      audit: {
        ticks: st?.tick ?? 0,
        sameIdentity:
          !!room.players[0] &&
          !!room.players[1] &&
          room.players[0].ipHash === room.players[1].ipHash,
      },
    });
    setTimeout(() => destroyRoom(room), 60_000);
  }

  // both sides readied up. For a friendly pit that's the bell; for a wagered
  // one the coins escrow first (both wallets debited atomically) and the fight
  // only starts if the lock holds — nobody fights for a pot that isn't there.
  function beginFight(room: Room) {
    const wager = room.options.wager;
    if (room.bot || wager <= 0) {
      startCountdown(room);
      return;
    }
    const a = room.players[0];
    const b = room.players[1];
    if (!a || !b || !a.handle || !b.handle) {
      destroyRoom(room);
      return;
    }
    // freeze the seat while the DB call is in flight — a stray accept/intent
    // does nothing, and a leaver is handled by the post-await guard below
    room.phase = "locking";
    if (room.reviewTimer) clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
    openDuelWager(room.code, a.handle, b.handle, wager)
      .then((id) => {
        // the room may have moved under the await: a leaver emptied a seat, a
        // reclaim reshuffled it, or a sweep closed it. If so, unwind the lock.
        const stillLive =
          rooms.get(room.code) === room &&
          room.phase === "locking" &&
          !!room.players[0] &&
          !!room.players[1];
        if (!stillLive) {
          if (id) refundDuelWager(id).catch(() => {});
          if (rooms.get(room.code) === room) {
            // let whoever's still seated know why the pit vanished (their
            // own stake, if any, was just refunded)
            roomSend(room, {
              t: "error",
              msg: "the other fighter stepped out before the bell — your stake is back",
            });
            destroyRoom(room);
          }
          return;
        }
        if (!id) {
          // one wallet couldn't cover (or the DB is away) — nothing was
          // debited; send both back to the board rather than a broken pit
          roomSend(room, {
            t: "error",
            msg: "the wager couldn't be locked — both fighters need the coins in their 𝕏 wallet",
          });
          destroyRoom(room);
          return;
        }
        room.wagerId = id;
        startCountdown(room);
      })
      .catch(() => {
        roomSend(room, { t: "error", msg: "the wager couldn't be locked — try again" });
        destroyRoom(room);
      });
  }

  function startCountdown(room: Room) {
    if (room.reviewTimer) clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
    room.phase = "countdown";
    room.seed = randomInt(1, 2 ** 31 - 1);
    room.state = createArena(room.seed, room.options);
    room.log = [];
    room.pending = [{}, {}];
    room.fightIds = [
      { handle: room.players[0]!.handle, ip: room.players[0]!.ipHash },
      { handle: room.players[1]!.handle, ip: room.players[1]!.ipHash },
    ];
    const names = [room.players[0]!.nickname, room.players[1]!.nickname];
    for (let i = 0; i < 2; i++) {
      const sw = room.players[i]!.ws;
      if (!sw) continue;
      send(sw, {
        t: "begin",
        youAre: i,
        names,
        options: room.options,
        countdownTicks: COUNTDOWN_TICKS,
        tickMs: TICK_MS,
        version: ARENA_VERSION,
      });
    }
    let left = COUNTDOWN_TICKS;
    room.timer = setInterval(() => {
      if (left > 0) {
        roomSend(room, { t: "count", n: left });
        left -= 1;
        return;
      }
      // the bell — from here on, every interval is a combat tick
      room.phase = "fight";
      roomSend(room, { t: "count", n: 0 });
      if (room.timer) clearInterval(room.timer);
      room.timer = setInterval(() => tickRoom(room), TICK_MS);
    }, TICK_MS);
  }

  function botIntent(room: Room): Record<string, unknown> {
    const st = room.state!;
    const rng = (room.botRng ??= mulberry32((room.seed ^ 0x5eedb0d) >>> 0));
    const me = st.fighters[1];
    const it: Record<string, unknown> = { engage: true };
    // reshuffle the rack now and then — variance is the whole meta
    if (st.tick % 8 === 3 && rng() < 0.7) {
      const rack = room.options.weapons;
      it.weapon = rack[Math.floor(rng() * rack.length)];
    }
    if (me.hp < 35 && me.berries > 0 && rng() < 0.6) it.eat = true;
    if (me.specEnergy >= 50 && rng() < 0.25) it.spec = true;
    return it;
  }

  function tickRoom(room: Room) {
    const st = room.state;
    if (!st || room.phase !== "fight") return;
    if (room.bot) {
      const bi = botIntent(room);
      const p = room.pending[1] as Record<string, unknown>;
      Object.assign(p, bi);
    }
    const [ia, ib] = room.pending;
    room.pending = [{}, {}];
    room.log.push([ia, ib]);
    stepArena(st, ia, ib);
    roomSend(room, { t: "tick", snap: arenaSnapshot(st) });
    if (st.over) {
      endFight(room, st.winner, st.fighters[0].hp === 0 || st.fighters[1].hp === 0 ? "ko" : "time");
    }
  }

  function seatIndex(room: Room, ws: WebSocket): number {
    return room.players.findIndex((p) => p?.ws === ws);
  }

  /** the one live challenge this handle owns, seated or not */
  function findHostRoom(handle: string): Room | null {
    if (!handle) return null;
    const h = handle.toLowerCase();
    for (const room of rooms.values()) {
      if (!room.bot && room.phase !== "done" && room.hostHandle.toLowerCase() === h) {
        return room;
      }
    }
    return null;
  }

  function startReview(room: Room) {
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    // BOTH sides ready up fresh — the creator may have wandered off
    // since posting the pit, and nobody fights an empty chair
    room.phase = "review";
    for (const p of room.players) if (p) p.accepted = false;
    const names = room.players.map((p) => p?.nickname ?? "?");
    for (let i = 0; i < 2; i++) {
      const pw = room.players[i]?.ws;
      if (pw) {
        send(pw, {
          t: "review",
          code: room.code,
          names,
          options: room.options,
          youAre: i,
        });
      }
    }
    if (room.reviewTimer) clearTimeout(room.reviewTimer);
    room.reviewTimer = setTimeout(() => {
      if (room.phase !== "review") return;
      // whoever didn't confirm is treated as gone
      for (let i = 1; i >= 0; i--) {
        const p = room.players[i];
        if (p && !p.accepted) {
          if (p.ws) {
            send(p.ws, {
              t: "error",
              msg: "you didn't ready up in time — the pit moved on",
            });
            p.ws.close();
          } else {
            leaveRoom(room, i);
          }
        }
      }
    }, REVIEW_TIMEOUT_MS);
  }

  /** seat 0 is yours by handle — retake it (kicking a stale tab if one is
   *  still sitting there) and pick the fight back up where it stood */
  function reclaimPit(room: Room, slot: Slot, ws: WebSocket) {
    const prev = room.players[0];
    if (prev?.ws && prev.ws !== ws) {
      send(prev.ws, { t: "error", msg: "your pit moved to another tab" });
      prev.ws.close();
    }
    slot.accepted = true;
    room.players[0] = slot;
    if (room.players[1]) startReview(room);
    else
      send(ws, {
        t: "lobby",
        code: room.code,
        youAre: 0,
        options: room.options,
        expiresAt: room.createdAt + ROOM_TTL_MS,
      });
  }

  function leaveRoom(room: Room, idx: number, disconnected = false) {
    if (room.bot) {
      destroyRoom(room);
      return;
    }
    if (room.phase === "locking") {
      // the escrow is mid-flight — just vacate the seat. beginFight's
      // post-await guard sees the empty chair, refunds the lock, and tears
      // the pit down; jumping in here would race that.
      room.players[idx] = null;
      return;
    }
    const other = room.players[1 - idx];
    room.players[idx] = null;
    if (room.phase === "fight" || room.phase === "countdown") {
      // mid-fight leavers get a short grace (tab refresh, blip), then lose
      room.graceTimer = setTimeout(() => {
        endFight(room, 1 - idx, "forfeit");
      }, FORFEIT_GRACE_MS);
      if (other?.ws) send(other.ws, { t: "peer-blip", graceMs: FORFEIT_GRACE_MS });
      return;
    }
    if (other) {
      if (idx === 0 && !disconnected && room.phase !== "done") {
        // the host cancelled underfoot — don't leave the challenger
        // holding a pit that was never theirs
        if (other.ws) send(other.ws, { t: "error", msg: "the host cancelled the pit" });
        destroyRoom(room);
        return;
      }
      room.phase = "waiting";
      other.accepted = room.players.indexOf(other) === 0;
      if (other.ws) send(other.ws, { t: "peer-left" });
      return;
    }
    if (disconnected && room.phase === "waiting" && idx === 0) {
      // a blinked tab doesn't cancel the challenge: the pit persists —
      // unlisted while the seat is cold — until the host reclaims it,
      // cancels it, or the sweep closes it at the 30-minute mark
      return;
    }
    destroyRoom(room);
  }

  // rooms too old to matter get swept on a clock (so an abandoned pit
  // closes on time even when nobody else is entering the arena) and again
  // whenever anything happens
  function sweep() {
    // crash recovery: refund any escrow a dead process stranded 'open'. A
    // fresh hub reclaims the previous one's orphaned wagers here within a
    // minute of boot (the RPC only touches rows older than its own threshold).
    refundStaleWagers().catch(() => {});
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.phase !== "fight" && now - room.createdAt > ROOM_TTL_MS) {
        roomSend(room, {
          t: "error",
          msg: "the pit sat open for 30 minutes and closed on its own",
        });
        destroyRoom(room);
      }
    }
  }
  setInterval(sweep, 60_000).unref();

  (globalThis as Record<string, unknown>).__fbArenaPits = () => ({
    open: Array.from(rooms.values())
      .filter(
        // a vacated pit (host mid-refresh or wandered off) stays alive but
        // off the board — nobody should knock on a cold seat
        (r) =>
          r.phase === "waiting" && r.listed && !r.bot && !!r.players[0] && !r.players[1]
      )
      .map((r) => ({
        code: r.code,
        host: r.players[0]?.nickname ?? "?",
        options: r.options,
        createdAt: r.createdAt,
      })),
    fights: Array.from(rooms.values())
      .filter((r) => r.phase === "fight" && !r.bot)
      .map((r) => ({
        code: r.code,
        names: [r.players[0]?.nickname ?? "?", r.players[1]?.nickname ?? "?"],
        watchers: r.spectators.length,
      })),
  });

  wss.on("connection", (ws: WebSocket) => {
    let myRoom: Room | null = null;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const t = msg.t;

      if (t === "spectate") {
        // ringside is open to all — no X handle needed to watch
        const auth = readTicket(msg.ticket);
        if (!auth) {
          send(ws, { t: "error", msg: "ticket expired — reopen the arena" });
          ws.close();
          return;
        }
        const room = rooms.get(String(msg.code ?? "").toUpperCase());
        if (!room || room.phase === "done" || !room.state) {
          send(ws, { t: "error", msg: "that fight is over (or never was)" });
          return;
        }
        if (room.spectators.length >= 50) {
          send(ws, { t: "error", msg: "ringside is full" });
          return;
        }
        room.spectators.push(ws);
        ws.on("close", () => {
          room.spectators = room.spectators.filter((w) => w !== ws);
        });
        send(ws, {
          t: "begin",
          youAre: -1,
          names: [room.players[0]?.nickname ?? "?", room.players[1]?.nickname ?? "?"],
          options: room.options,
          countdownTicks: 0,
          tickMs: TICK_MS,
          version: ARENA_VERSION,
        });
        send(ws, { t: "tick", snap: arenaSnapshot(room.state) });
        return;
      }

      if (t === "create" || t === "join" || t === "bot") {
        if (myRoom) return;
        sweep();
        const auth = readTicket(msg.ticket);
        if (!auth) {
          send(ws, { t: "error", msg: "ticket expired — reopen the arena" });
          ws.close();
          return;
        }
        // PvP seats are X-gated: one verified account, one bird. The fight
        // name IS the handle, so the daily duel board can't be farmed with
        // throwaway names. The bot doesn't care who it spars.
        if (t !== "bot" && !auth.handle) {
          send(ws, {
            t: "error",
            msg: "duels are 𝕏-verified — connect your account to fight",
          });
          return;
        }
        const nickname =
          t === "bot"
            ? String(msg.nickname ?? "").toUpperCase()
            : auth.handle.toUpperCase().slice(0, 15);
        if (t === "bot" && !NICK_RE.test(nickname)) {
          send(ws, { t: "error", msg: "bird name: 3–12 letters/numbers" });
          return;
        }
        // same-network (or same-person) fights are allowed — households
        // and NATs share hashes — but the match is tagged sameIdentity in
        // the audit and scores nothing on the duel board (see endFight)
        const slot: Slot = {
          ws,
          nickname,
          handle: auth.handle,
          ipHash: auth.ipHash,
          accepted: false,
          intents: 0,
        };

        if (t === "bot") {
          if (rooms.size >= MAX_ROOMS) {
            send(ws, { t: "error", msg: "the arena is packed — try again soon" });
            return;
          }
          const room: Room = {
            code: makeCode(),
            listed: false,
            bot: true,
            botRng: null,
            options: normalizeArenaOptions(msg.options),
            players: [null, null],
            phase: "waiting",
            state: null,
            seed: 0,
            log: [],
            pending: [{}, {}],
            fightIds: null,
            wagerId: null,
            spectators: [],
            timer: null,
            graceTimer: null,
            reviewTimer: null,
            hostHandle: "",
            createdAt: Date.now(),
          };
          slot.accepted = true;
          room.players[0] = slot;
          room.players[1] = {
            ws: null,
            nickname: "PIT BOT",
            handle: "",
            ipHash: "bot",
            accepted: true,
            intents: 0,
          };
          rooms.set(room.code, room);
          myRoom = room;
          startCountdown(room);
          return;
        }

        // one challenge per bird: whatever door you come through, an open
        // pit of yours is the pit you get back — the code (and any link
        // already shared) stays good across refreshes, tabs and reopens
        const mine = findHostRoom(auth.handle);
        if (t === "create" && mine) {
          if (mine.phase !== "waiting") {
            send(ws, {
              t: "error",
              msg: `one duel at a time — you're mid-fight in pit ${mine.code}`,
            });
            return;
          }
          // fresh terms only while nobody sits across the pit
          if (!mine.players[1]) mine.options = normalizeArenaOptions(msg.options);
          myRoom = mine;
          reclaimPit(mine, slot, ws);
          return;
        }

        let room: Room | null = null;
        if (t === "join") {
          room = rooms.get(String(msg.code ?? "").toUpperCase()) ?? null;
          if (!room || room.players.every(Boolean) || room.phase !== "waiting") {
            send(ws, { t: "error", msg: "that pit is empty or already fighting" });
            return;
          }
          if (mine === room) {
            // the host walking back through their own challenge link — a
            // reclaim, not a self-fight
            myRoom = room;
            reclaimPit(room, slot, ws);
            return;
          }
          if (!room.players[0]) {
            send(ws, {
              t: "error",
              msg: "the host stepped out — give them a moment and try again",
            });
            return;
          }
          if (mine) {
            if (mine.phase !== "waiting") {
              send(ws, {
                t: "error",
                msg: `one duel at a time — you're mid-fight in pit ${mine.code}`,
              });
              return;
            }
            // stepping into another pit abandons your own
            roomSend(mine, { t: "error", msg: "the host stepped into another pit" });
            destroyRoom(mine);
          }
        }

        if (!room) {
          if (rooms.size >= MAX_ROOMS) {
            send(ws, { t: "error", msg: "the arena is packed — try again soon" });
            return;
          }
          room = {
            code: makeCode(),
            listed: msg.listed !== false,
            bot: false,
            botRng: null,
            options: normalizeArenaOptions(msg.options),
            players: [null, null],
            phase: "waiting",
            state: null,
            seed: 0,
            log: [],
            pending: [{}, {}],
            fightIds: null,
            wagerId: null,
            spectators: [],
            timer: null,
            graceTimer: null,
            reviewTimer: null,
            hostHandle: auth.handle,
            createdAt: Date.now(),
          };
          rooms.set(room.code, room);
          slot.accepted = true; // moot until a challenger arrives
          room.players[0] = slot;
          myRoom = room;
          send(ws, {
            t: "lobby",
            code: room.code,
            youAre: 0,
            options: room.options,
            expiresAt: room.createdAt + ROOM_TTL_MS,
          });
          return;
        }

        const idx = room.players[0] ? 1 : 0;
        room.players[idx] = slot;
        myRoom = room;
        startReview(room);
        return;
      }

      if (!myRoom) return;
      const idx = seatIndex(myRoom, ws);
      if (idx === -1) return;

      if (t === "accept" && myRoom.phase === "review") {
        myRoom.players[idx]!.accepted = true;
        roomSend(myRoom, {
          t: "ready",
          ready: [
            myRoom.players[0]?.accepted === true,
            myRoom.players[1]?.accepted === true,
          ],
        });
        if (myRoom.players.every((p) => p?.accepted)) beginFight(myRoom);
        return;
      }

      if (t === "intent" && myRoom.phase === "fight") {
        const slot = myRoom.players[idx]!;
        slot.intents += 1;
        if (slot.intents > 20_000) return; // runaway spam, drop silently
        const p = myRoom.pending[idx];
        if (msg.engage === true) p.engage = true;
        if (msg.eat === true) p.eat = true;
        if (msg.spec === true) p.spec = true;
        if (msg.weapon !== undefined) p.weapon = Number(msg.weapon);
        return;
      }

      if (t === "leave") {
        const room = myRoom;
        myRoom = null;
        leaveRoom(room, idx);
      }
    });

    ws.on("close", () => {
      if (!myRoom) return;
      const idx = seatIndex(myRoom, ws);
      const room = myRoom;
      myRoom = null;
      // a dropped socket is not a cancel — leaveRoom keeps a waiting
      // host's pit alive for the reclaim
      if (idx !== -1) leaveRoom(room, idx, true);
    });
  });

  return wss;
}
