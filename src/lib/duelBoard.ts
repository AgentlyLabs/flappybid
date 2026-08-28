import { db } from "./db";
import { utcDay, utcYesterday, msUntilClose } from "./day";

// The duel arena's daily board: +1 per PvP win, -1 per loss, floored at
// zero (the clamp is sequential — a loss taken at 0 costs nothing and
// never eats a future win; see 0022_duel_losses.sql). Keyed by the
// verified X handle the hub stamped on the fight. Mirrors
// board.ts/close.ts — lazy close crowns yesterday's top duelist into
// duel_hall_of_fame, where they retire undefeated and stop appearing on
// (or winning) future boards.
//
// NOTE: imports here stay relative — the ws hub (run by tsx via server.ts,
// outside the Next compiler) calls recordDuelWin, and tsx doesn't resolve
// the @/ alias.

export interface DuelBoardEntry {
  rank: number;
  handle: string;
  score: number;
  wins: number;
  losses: number;
  lastFightAt: string | null;
  /** duelist-chosen URL, shown on the board in place of the @handle */
  refLink: string | null;
  /** outbound clicks the row has sent today (via /out/duel/:handle) */
  clicks: number;
}

export interface DuelChampion {
  date: string;
  handle: string;
  score: number;
  refLink: string | null;
}

export interface DuelBoard {
  day: string;
  closesInMs: number;
  entries: DuelBoardEntry[];
  /** yesterday's crown — still reigning until the next close */
  champion: DuelChampion | null;
  /** every earlier crown, newest first (the reigning one excluded) */
  hall: DuelChampion[];
}

type BoardRow = {
  handle: string;
  score: number;
  wins: number;
  losses: number;
  last_fight_at: string | null;
};
type HallRow = { date: string; handle: string; score: number };

/** Ref links for a set of handles, keyed by lower-case handle. Missing
 *  table, DB hiccup, or no links all read the same: an empty map. */
async function refLinksFor(handles: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const keys = [...new Set(handles.map((h) => h.toLowerCase()))];
  if (keys.length === 0) return map;
  try {
    const { data } = await db()
      .from("duel_ref_links")
      .select("handle_lower, url")
      .in("handle_lower", keys);
    for (const r of (data as { handle_lower: string; url: string }[] | null) ??
      []) {
      map.set(r.handle_lower, r.url);
    }
  } catch {
    // the board renders handles without links rather than not at all
  }
  return map;
}

/** Today's outbound click tally per handle, keyed by lower-case handle.
 *  Missing table, DB hiccup, or no clicks all read the same: an empty map. */
async function clicksFor(
  handles: string[],
  day: string
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const keys = [...new Set(handles.map((h) => h.toLowerCase()))];
  if (keys.length === 0) return map;
  try {
    const { data } = await db()
      .from("duel_entry_clicks")
      .select("handle_lower, clicks")
      .eq("day", day)
      .in("handle_lower", keys);
    for (const r of (data as
      | { handle_lower: string; clicks: number }[]
      | null) ?? []) {
      map.set(r.handle_lower, Number(r.clicks));
    }
  } catch {
    // no click table yet — rows render without a count
  }
  return map;
}

/** One ledger row per PvP verdict. Called fire-and-forget from the hub's
 *  endFight — a DB hiccup must never touch a live fight. */
export async function recordDuelWin(win: {
  handle: string;
  opponent: string;
  code: string;
  reason: string;
  ticks: number;
  ipHash: string | null;
}): Promise<void> {
  await db().from("duel_wins").insert({
    day: utcDay(),
    handle: win.handle,
    opponent: win.opponent,
    code: win.code,
    reason: win.reason,
    ticks: win.ticks,
    ip_hash: win.ipHash,
  });
}

// Idempotent, same contract as close.ts: the first read after midnight
// crowns yesterday even if no cron ever fires. No human-review gate — the
// server simulated every tick of every fight itself, so the ledger is
// already the truth.
async function ensureDuelFinalized(day: string): Promise<void> {
  if (day >= utcDay()) return; // never close a day that's still running

  const client = db();
  const { data: existing } = await client
    .from("duel_hall_of_fame")
    .select("date")
    .eq("date", day)
    .maybeSingle();
  if (existing) return;

  const { data } = await client.rpc("duel_board", { p_day: day });
  const top = ((data as BoardRow[] | null) ?? [])[0];
  if (!top || top.score <= 0) return; // nobody scored that day — the slot stays empty

  const { error } = await client.from("duel_hall_of_fame").insert({
    date: day,
    handle: top.handle,
    score: top.score,
  });
  // unique(date) — a concurrent close beat us; that's fine
  if (error && error.code !== "23505") throw error;
}

/** Yesterday's crown, shaped for the arena's showcase banner. Reigns until
 *  the next close; null before the first crown or when the DB is away. */
export async function reigningDuelChampion(): Promise<DuelChampion | null> {
  try {
    const yesterday = utcYesterday();
    try {
      await ensureDuelFinalized(yesterday);
    } catch {
      // reads must never fail because the close hiccuped
    }
    const { data } = await db()
      .from("duel_hall_of_fame")
      .select("date, handle, score")
      .eq("date", yesterday)
      .maybeSingle();
    if (!data) return null;
    const links = await refLinksFor([data.handle]);
    return {
      date: data.date,
      handle: data.handle,
      score: data.score,
      refLink: links.get(data.handle.toLowerCase()) ?? null,
    };
  } catch {
    return null;
  }
}

export function emptyDuelBoard(): DuelBoard {
  return {
    day: utcDay(),
    closesInMs: msUntilClose(),
    entries: [],
    champion: null,
    hall: [],
  };
}

export async function getDuelBoard(limit = 50): Promise<DuelBoard> {
  try {
    const client = db();
    const today = utcDay();
    const yesterday = utcYesterday();

    try {
      await ensureDuelFinalized(yesterday);
    } catch {
      // reads must never fail because the close hiccuped
    }

    const [{ data: rows }, { data: hallRows }] = await Promise.all([
      client.rpc("duel_board", { p_day: today }),
      client
        .from("duel_hall_of_fame")
        .select("date, handle, score")
        .order("date", { ascending: false })
        .limit(365),
    ]);

    const boardRows = (((rows as BoardRow[] | null) ?? [])).slice(0, limit);
    const hallList = (hallRows as HallRow[] | null) ?? [];
    const [links, clicks] = await Promise.all([
      refLinksFor([
        ...boardRows.map((r) => r.handle),
        ...hallList.map((r) => r.handle),
      ]),
      clicksFor(boardRows.map((r) => r.handle), today),
    ]);

    const entries: DuelBoardEntry[] = boardRows.map((r, i) => ({
      rank: i + 1,
      handle: r.handle,
      score: Number(r.score),
      wins: Number(r.wins),
      losses: Number(r.losses),
      lastFightAt: r.last_fight_at,
      refLink: links.get(r.handle.toLowerCase()) ?? null,
      clicks: clicks.get(r.handle.toLowerCase()) ?? 0,
    }));

    const hall = hallList.map((r) => ({
      date: r.date,
      handle: r.handle,
      score: r.score,
      refLink: links.get(r.handle.toLowerCase()) ?? null,
    }));
    const champion = hall.find((c) => c.date === yesterday) ?? null;

    return {
      day: today,
      closesInMs: msUntilClose(),
      entries,
      champion,
      hall: hall.filter((c) => c !== champion),
    };
  } catch {
    // DB missing/unreachable — the arena still opens
    return emptyDuelBoard();
  }
}
