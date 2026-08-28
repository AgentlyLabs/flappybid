import { db } from "./db";
import { utcDay, utcYesterday, msUntilClose } from "./day";
import { ensureFinalized } from "./close";

// Today's board and the all-time champion list. Shared by the server-rendered
// homepage (so crawlers see the entries) and the polling API routes.

export interface BoardEntry {
  rank: number;
  id: string;
  slug: string;
  kind: "url" | "handle";
  name: string;
  url: string;
  score: number;
  runs: number;
  bestAt: string | null;
  clicks: number;
}

export interface Champion {
  date: string;
  slug: string;
  kind: "url" | "handle";
  name: string;
  url: string;
  score: number;
  runsTaken: number;
  clicks: number;
}

export interface Board {
  day: string;
  closesInMs: number;
  totalPlayers: number;
  /** all-time run count, not just today's */
  totalRuns: number;
  entries: BoardEntry[];
  champion: Champion | null;
}

type ProductRow = {
  id: string;
  slug: string;
  kind: "url" | "handle";
  name: string;
  url: string;
};

// Recompute one entry's daily best from its remaining scored runs, by the
// board's own currency (effective = raw × PH boost). For the admin verdicts
// that disqualify runs AFTER they were folded into daily_scores — review
// rejections and device bans — so the board reflects the verdict on the
// spot. best_score 0 drops the row off the board (it renders gt 0 only).
export async function recomputeDailyBest(
  client: ReturnType<typeof db>,
  productId: string,
  day: string
): Promise<void> {
  const remaining = await client
    .from("runs")
    .select("score, effective_score, submitted_at")
    .eq("product_id", productId)
    .eq("day", day)
    .eq("status", "scored")
    .order("effective_score", { ascending: false, nullsFirst: false })
    .order("submitted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let next = remaining.data;
  if (remaining.error) {
    // effective_score missing (older database): raw score is
    // the board score
    ({ data: next } = await client
      .from("runs")
      .select("score, submitted_at")
      .eq("product_id", productId)
      .eq("day", day)
      .eq("status", "scored")
      .order("score", { ascending: false })
      .order("submitted_at", { ascending: true })
      .limit(1)
      .maybeSingle());
  }
  const nextBest =
    (next as { effective_score?: number | null } | null)?.effective_score ??
    next?.score ??
    0;
  await client
    .from("daily_scores")
    .update({
      best_score: nextBest,
      best_at: next?.submitted_at ?? null,
    })
    .eq("product_id", productId)
    .eq("day", day);
}

export function emptyBoard(): Board {
  return {
    day: utcDay(),
    closesInMs: msUntilClose(),
    totalPlayers: 0,
    totalRuns: 0,
    entries: [],
    champion: null,
  };
}

export async function getBoard(limit = 100): Promise<Board> {
  try {
    return await buildBoard(db(), utcDay(), utcYesterday(), limit);
  } catch {
    // DB missing/unreachable — serve an empty board so the page still renders
    return emptyBoard();
  }
}

async function buildBoard(
  client: ReturnType<typeof db>,
  today: string,
  yesterday: string,
  limit: number
): Promise<Board> {
  // lazy close: even if the cron missed, the first read after midnight
  // finalizes yesterday
  try {
    await ensureFinalized(yesterday);
  } catch {
    // reads must never fail because the close hiccuped
  }

  // PostgREST caps any single response at 1000 rows, so deep pages are
  // fetched chunk by chunk until `limit` or the day runs out of scorers
  const fetchRows = async () => {
    type ScoreRow = {
      best_score: number;
      best_at: string | null;
      runs_count: number;
      products: unknown;
    };
    const all: ScoreRow[] = [];
    for (let from = 0; from < limit; from += 1000) {
      const to = Math.min(from + 1000, limit) - 1;
      const { data } = await client
        .from("daily_scores")
        .select(
          "best_score, best_at, runs_count, products!inner(id, slug, kind, name, url)"
        )
        .eq("day", today)
        .gt("best_score", 0)
        .order("best_score", { ascending: false })
        .order("best_at", { ascending: true })
        .range(from, to);
      all.push(...((data as ScoreRow[] | null) ?? []));
      if (!data || data.length < to - from + 1) break;
    }
    return all;
  };

  const [rows, { count: playerCount }, { data: champRow }, { count: runCount }] =
    await Promise.all([
      fetchRows(),
      // the exact count tells the client whether more rows exist past `limit`
      client
        .from("daily_scores")
        .select("product_id", { count: "exact", head: true })
        .eq("day", today)
        .gt("best_score", 0),
      client
        .from("hall_of_fame")
        .select(
          "date, best_score, runs_taken, clicks_sent, products(id, slug, kind, name, url)"
        )
        .eq("date", yesterday)
        .maybeSingle(),
      // every run ever taken, one row each in `runs` — the hero shows the
      // all-time total next to the visitor counters (a head count dodges
      // both the 1000-row response cap and a table scan)
      client.from("runs").select("id", { count: "exact", head: true }),
    ]);

  const totalRuns = runCount ?? 0;

  // separate query so the board keeps rendering (clicks all 0) until the
  // clicks_count migration is applied
  const clicks = new Map<string, number>();
  const { data: clickRows } = await client
    .from("daily_scores")
    .select("product_id, clicks_count")
    .eq("day", today)
    .gt("clicks_count", 0);
  for (const r of clickRows ?? []) clicks.set(r.product_id, r.clicks_count);

  const entries: BoardEntry[] = rows.map((r, i) => {
    const p = r.products as unknown as ProductRow;
    return {
      rank: i + 1,
      id: p.id,
      slug: p.slug,
      kind: p.kind,
      name: p.name,
      url: p.url,
      score: r.best_score,
      runs: r.runs_count,
      bestAt: r.best_at,
      clicks: clicks.get(p.id) ?? 0,
    };
  });

  const champProduct = champRow?.products as unknown as ProductRow | undefined;
  const champion: Champion | null =
    champRow && champProduct
      ? {
          date: champRow.date,
          slug: champProduct.slug,
          kind: champProduct.kind,
          name: champProduct.name,
          url: champProduct.url,
          score: champRow.best_score,
          runsTaken: champRow.runs_taken,
          clicks: champRow.clicks_sent,
        }
      : null;

  return {
    day: today,
    closesInMs: msUntilClose(),
    totalPlayers: playerCount ?? entries.length,
    totalRuns,
    entries,
    champion,
  };
}

// Every retired champion, newest first. Champions retire undefeated — once a
// product lands here it stays forever. The most recent winner is still
// reigning (it owns the showcase banner until the next close), so it's
// excluded here until the next champion takes over.
export async function getHallChampions(): Promise<Champion[]> {
  try {
    const { data } = await db()
      .from("hall_of_fame")
      .select(
        "date, best_score, runs_taken, clicks_sent, products(slug, kind, name, url)"
      )
      .neq("date", utcYesterday())
      .order("date", { ascending: false })
      .limit(365);

    type Row = {
      date: string;
      best_score: number;
      runs_taken: number;
      clicks_sent: number;
      products: Omit<ProductRow, "id">;
    };

    return ((data as unknown as Row[]) ?? []).map((r) => ({
      date: r.date,
      slug: r.products.slug,
      kind: r.products.kind,
      name: r.products.name,
      url: r.products.url,
      score: r.best_score,
      runsTaken: r.runs_taken,
      clicks: r.clicks_sent,
    }));
  } catch {
    return [];
  }
}
