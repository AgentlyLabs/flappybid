import { db } from "./db";

// The all-time global leaderboard: one row per product that has ever posted a
// scored run, ranked by its best single run ever (banned products excluded),
// served a page at a time. All the heavy lifting — the per-product peak, the
// bans anti-join, the global rank and total count — lives in the
// global_leaderboard RPC; this just shapes it for the client.

export const GLOBAL_PAGE_SIZE = 50;

export interface GlobalEntry {
  rank: number;
  id: string;
  slug: string;
  kind: "url" | "handle";
  name: string;
  url: string;
  /** best single run ever, in the board's effective currency */
  score: number;
  daysPlayed: number;
  totalRuns: number;
}

export interface GlobalBoard {
  /** 1-based page index the entries belong to */
  page: number;
  pageSize: number;
  /** total eligible (non-banned) products across every page */
  totalPlayers: number;
  totalPages: number;
  entries: GlobalEntry[];
}

export function emptyGlobalBoard(page = 1): GlobalBoard {
  return {
    page,
    pageSize: GLOBAL_PAGE_SIZE,
    totalPlayers: 0,
    totalPages: 0,
    entries: [],
  };
}

type GlobalRow = {
  rank: number;
  product_id: string;
  slug: string;
  kind: "url" | "handle";
  name: string;
  url: string;
  best_score: number;
  best_at: string | null;
  days_played: number;
  total_runs: number;
  total_count: number;
};

export async function getGlobalBoard(page = 1): Promise<GlobalBoard> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  try {
    const { data, error } = await db().rpc("global_leaderboard", {
      row_limit: GLOBAL_PAGE_SIZE,
      row_offset: (safePage - 1) * GLOBAL_PAGE_SIZE,
    });
    if (error) throw error;

    const rows = (data as GlobalRow[] | null) ?? [];
    // total_count rides along on every row (window over the full set), so any
    // row carries the pager's total; empty page ⇒ nothing eligible past here
    const totalPlayers = rows.length > 0 ? Number(rows[0].total_count) : 0;

    return {
      page: safePage,
      pageSize: GLOBAL_PAGE_SIZE,
      totalPlayers,
      totalPages: Math.max(1, Math.ceil(totalPlayers / GLOBAL_PAGE_SIZE)),
      entries: rows.map((r) => ({
        rank: Number(r.rank),
        id: r.product_id,
        slug: r.slug,
        kind: r.kind,
        name: r.name,
        url: r.url,
        score: r.best_score,
        daysPlayed: Number(r.days_played),
        totalRuns: Number(r.total_runs),
      })),
    };
  } catch {
    // DB unreachable or the RPC missing — serve an empty board
    // so the tab still renders
    return emptyGlobalBoard(safePage);
  }
}
