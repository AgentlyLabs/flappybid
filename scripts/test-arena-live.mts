// Live E2E: two scripted players fight through the real custom server —
// HTTP ticket, ws join, options accept, countdown, authoritative ticks,
// verdict — then the broadcast audit bundle is re-simulated locally with
// arenaReplay and must reproduce the server's verdict exactly.
//
// Expects the custom server running (TURNSTILE_SECRET_KEY unset so the
// gate skips the browser challenge):
//   TURNSTILE_SECRET_KEY= PORT=3111 npm run dev:live
// then:
//   BASE=http://localhost:3111 npx tsx scripts/test-arena-live.mts

import WebSocket from "ws";
import {
  arenaReplay,
  normalizeArenaOptions,
  WEAPONS,
  type ArenaLog,
  type ArenaSnapshot,
} from "../src/game/arena.ts";

const BASE = process.env.BASE ?? "http://localhost:3111";
const WS_BASE = BASE.replace(/^http/, "ws");

interface Msg {
  t: string;
  [k: string]: unknown;
}

class Player {
  name: string;
  ws!: WebSocket;
  queue: Msg[] = [];
  waiters: Array<(m: Msg) => void> = [];
  youAre = 0;
  ended: Msg | null = null;

  constructor(name: string) {
    this.name = name;
  }

  async ticket(): Promise<string> {
    const res = await fetch(`${BASE}/api/arena/ticket`, {
      method: "POST",
      headers: { Origin: BASE },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${this.name} ticket: ${data.error}`);
    return data.ticket;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/arena`);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Msg;
        const w = this.waiters.shift();
        if (w) w(m);
        else this.queue.push(m);
      });
    });
  }

  send(m: Record<string, unknown>) {
    this.ws.send(JSON.stringify(m));
  }

  next(): Promise<Msg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${this.name}: timed out waiting`)), 15_000);
      this.waiters.push((msg) => {
        clearTimeout(to);
        resolve(msg);
      });
    });
  }

  async until(t: string): Promise<Msg> {
    for (;;) {
      const m = await this.next();
      if (m.t === "error") throw new Error(`${this.name} got error: ${m.msg}`);
      if (m.t === t) return m;
    }
  }
}

// A rides the rack, switching weapons; B locks one in and specs.
function switcherIntent(snap: ArenaSnapshot, me: number) {
  const mine = snap.fighters[me];
  const it: Record<string, unknown> = { t: "intent", engage: true };
  if (snap.tick % 5 === 2) it.weapon = (mine.weapon + 1) % WEAPONS.length;
  if (mine.hp < 40 && mine.berries > 0) it.eat = true;
  return it;
}
function brawlerIntent(snap: ArenaSnapshot, me: number) {
  const mine = snap.fighters[me];
  const it: Record<string, unknown> = { t: "intent", engage: true, weapon: 1 };
  if (mine.specEnergy >= 50) it.spec = true;
  if (mine.hp < 30 && mine.berries > 0) it.eat = true;
  return it;
}

async function main() {
  const a = new Player("ALICE");
  const b = new Player("BOBBIRD");

  const ta = await a.ticket();
  // the gate rate-limits per ip (1.5s gap) — two clients on one machine
  // queue up like anyone else
  await new Promise((r) => setTimeout(r, 1_700));
  const tb = await b.ticket();
  await a.connect();
  await b.connect();

  a.send({ t: "create", ticket: ta, nickname: "ALICE", options: {} });
  const lobby = await a.until("lobby");
  const code = String(lobby.code);
  console.log(`room ${code} open`);

  b.send({ t: "join", ticket: tb, nickname: "BOBBIRD", code });
  await Promise.all([a.until("review"), b.until("review")]);
  console.log("both seated, terms on the table");
  a.send({ t: "accept" });
  b.send({ t: "accept" });

  const [beginA, beginB] = await Promise.all([a.until("begin"), b.until("begin")]);
  a.youAre = Number(beginA.youAre);
  b.youAre = Number(beginB.youAre);
  console.log(`fight begins: ALICE seat ${a.youAre}, BOBBIRD seat ${b.youAre}`);

  // countdown → first tick → intents per tick until the end
  let ticks = 0;
  const endPromise = (async () => {
    for (;;) {
      const m = await a.next();
      if (m.t === "tick") {
        ticks += 1;
        const snap = m.snap as ArenaSnapshot;
        a.send(switcherIntent(snap, a.youAre));
      } else if (m.t === "end") {
        a.ended = m;
        return;
      } else if (m.t === "error") {
        throw new Error(`ALICE: ${m.msg}`);
      }
    }
  })();
  const endPromiseB = (async () => {
    for (;;) {
      const m = await b.next();
      if (m.t === "tick") {
        const snap = m.snap as ArenaSnapshot;
        b.send(brawlerIntent(snap, b.youAre));
      } else if (m.t === "end") {
        b.ended = m;
        return;
      } else if (m.t === "error") {
        throw new Error(`BOBBIRD: ${m.msg}`);
      }
    }
  })();
  // both must also engage on the very first tick — send an opener now
  a.send({ t: "intent", engage: true });
  b.send({ t: "intent", engage: true });

  await Promise.all([endPromise, endPromiseB]);
  const end = a.ended!;
  const W = ["seat0", "seat1", "draw"];
  console.log(
    `over: winner=${W[Number(end.winner)]} (${end.reason}) after ${ticks} ticks, ` +
      `hp ${JSON.stringify(end.hp)}, dmg ${JSON.stringify(end.dmg)}`
  );
  console.log(`audit: ${JSON.stringify(end.audit)}`);

  // the whole point: the broadcast bundle must re-simulate to the verdict
  const replayed = arenaReplay(
    Number(end.seed),
    normalizeArenaOptions(end.options),
    end.log as ArenaLog
  );
  const hp = end.hp as [number, number];
  const dmg = end.dmg as [number, number];
  const match =
    replayed.winner === Number(end.winner) &&
    replayed.hp[0] === hp[0] &&
    replayed.hp[1] === hp[1] &&
    replayed.dmg[0] === dmg[0] &&
    replayed.dmg[1] === dmg[1];
  console.log(
    `audit replay: winner=${W[replayed.winner]} hp ${JSON.stringify(replayed.hp)} ` +
      `dmg ${JSON.stringify(replayed.dmg)} → ${match ? "MATCHES SERVER" : "MISMATCH"}`
  );

  const sameIdentity = (end.audit as { sameIdentity?: boolean })?.sameIdentity;
  if (sameIdentity !== true) {
    console.log("expected sameIdentity=true for two localhost clients");
  }

  a.ws.close();
  b.ws.close();
  if (!match) process.exit(1);

  // -- the open-pits board lists a created duel --------------------------
  const c = new Player("CARL");
  await c.connect();
  c.send({ t: "create", ticket: ta, nickname: "CARL", options: {}, listed: true });
  await c.until("lobby");
  const pitsData = await (await fetch(`${BASE}/api/arena/pits`)).json();
  const carlListed = (pitsData.open as Array<{ host: string }>).some(
    (pit) => pit.host === "CARL"
  );
  console.log(`pits board: live=${pitsData.live}, CARL listed=${carlListed}`);
  c.send({ t: "leave" });
  c.ws.close();
  if (!pitsData.live || !carlListed) process.exit(1);

  // -- a human vs the pit bot, audited like any fight --------------------
  const d = new Player("DAISY");
  await d.connect();
  d.send({ t: "bot", ticket: tb, nickname: "DAISY" });
  await d.until("begin");
  let botTicks = 0;
  let botEnd: Msg | null = null;
  for (;;) {
    const m = await d.next();
    if (m.t === "tick") {
      botTicks += 1;
      d.send(brawlerIntent(m.snap as ArenaSnapshot, 0));
    } else if (m.t === "end") {
      botEnd = m;
      break;
    } else if (m.t === "error") {
      throw new Error(`DAISY: ${m.msg}`);
    }
  }
  console.log(
    `bot round: winner=${W[Number(botEnd!.winner)]} (${botEnd!.reason}) in ${botTicks} ticks, ` +
      `dmg ${JSON.stringify(botEnd!.dmg)}`
  );
  const botReplay = arenaReplay(
    Number(botEnd!.seed),
    normalizeArenaOptions(botEnd!.options),
    botEnd!.log as ArenaLog
  );
  const botMatch =
    botReplay.winner === Number(botEnd!.winner) &&
    JSON.stringify(botReplay.dmg) === JSON.stringify(botEnd!.dmg);
  console.log(`bot audit replay: ${botMatch ? "MATCHES SERVER" : "MISMATCH"}`);
  d.ws.close();
  if (!botMatch) process.exit(1);

  console.log("\nALL OK");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
