import { db } from "./db";
import { utcDay } from "./day";

// Finalize a completed UTC day: the top score becomes the champion, gets a
// hall_of_fame row (one per date, forever) and retires undefeated.
// Idempotent — safe to call from the cron route AND lazily from reads, so
// the close happens even if the cron misses.
//
// Crowning is gated on human review: an owner watches the winning run's
// ghost replay on /admin and approves it (bots that survive the statistical
// checks still look wrong to a human). Until then the day simply stays
// unfinalized — the cron and lazy closes keep retrying and remain no-ops.

export interface CandidateRun {
  id: string;
  seed: number;
  score: number;
  /** PH vote multiplier; absent on older databases = 1 */
  boost?: number | null;
  flap_frames: number[];
  /** shot inputs on combat maps; null on every other run */
  shot_frames: number[] | null;
  cheat_reason: string | null;
  review: "approved" | "rejected" | null;
  ip_hash: string | null;
  submitted_at: string;
  /** map the run was flown on; defaults to classic on older databases */
  map: string;
  /** device cookie behind the run; null on older databases */
  device_id?: string | null;
  /** live-checkpoint nonce: present = the run was
   *  streamed and audited live; absent = pre-protocol run */
  cp_nonce?: string | null;
  /** the audited beats themselves ({f,h,t} rows) when cp_nonce is set */
  checkpoints?: unknown;
}

export interface ChampionCandidate {
  productId: string;
  bestScore: number;
  runsCount: number;
  product: { slug: string; kind: string; name: string };
  /** the exact run a verdict attaches to; null only for legacy pre-forensics rows */
  run: CandidateRun | null;
}

/** The run that would be crowned if `day` closed now: the best run of the
 *  day's top entry (same ordering as the close itself). */
export async function championCandidate(
  day: string
): Promise<ChampionCandidate | null> {
  const client = db();

  const { data: top } = await client
    .from("daily_scores")
    .select("product_id, best_score, best_at, runs_count, products(slug, kind, name)")
    .eq("day", day)
    .gt("best_score", 0)
    .order("best_score", { ascending: false })
    .order("best_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!top) return null;

  // the board ranks by effective score (raw × PH vote boost, migration
  // 0015), so the run put up for review must be picked the same way —
  // daily_scores.best_score and the crowned run have to agree
  const first = await client
    .from("runs")
    .select("id, seed, score, boost, effective_score, flap_frames, shot_frames, cheat_reason, review, ip_hash, submitted_at, map, device_id, cp_nonce, checkpoints")
    .eq("product_id", top.product_id)
    .eq("day", day)
    .eq("status", "scored")
    .not("flap_frames", "is", null)
    .order("effective_score", { ascending: false, nullsFirst: false })
    .order("submitted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  type CandidateRow = Omit<CandidateRun, "seed" | "map"> & {
    seed: number | string;
    map?: string | null;
  };
  let run: CandidateRow | null = first.data;
  if (first.error) {
    // device/checkpoint columns missing (older database):
    // same boost-aware pick without the new forensics
    const second = await client
      .from("runs")
      .select("id, seed, score, boost, effective_score, flap_frames, shot_frames, cheat_reason, review, ip_hash, submitted_at, map")
      .eq("product_id", top.product_id)
      .eq("day", day)
      .eq("status", "scored")
      .not("flap_frames", "is", null)
      .order("effective_score", { ascending: false, nullsFirst: false })
      .order("submitted_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    run = second.data;
    if (second.error) {
      // boost columns missing too (older database): raw score
      // is the board score, order by it as before
      ({ data: run } = await client
        .from("runs")
        .select("id, seed, score, flap_frames, shot_frames, cheat_reason, review, ip_hash, submitted_at, map")
        .eq("product_id", top.product_id)
        .eq("day", day)
        .eq("status", "scored")
        .not("flap_frames", "is", null)
        .order("score", { ascending: false })
        .order("submitted_at", { ascending: true })
        .limit(1)
        .maybeSingle());
    }
  }

  return {
    productId: top.product_id,
    bestScore: top.best_score,
    runsCount: top.runs_count,
    product: top.products as unknown as ChampionCandidate["product"],
    run: run
      ? { ...run, seed: Number(run.seed), map: run.map ?? "classic" }
      : null,
  };
}

export async function ensureFinalized(day: string): Promise<void> {
  if (day >= utcDay()) return; // never close a day that's still running

  const client = db();

  const { data: existing } = await client
    .from("hall_of_fame")
    .select("date")
    .eq("date", day)
    .maybeSingle();
  if (existing) return;

  const top = await championCandidate(day);
  if (!top) return; // nobody scored that day — no champion, slot stays empty

  // Human gate. A rejected top run never reaches this point: the review
  // endpoint disqualifies it and recomputes the board on the spot.
  if (top.run?.review !== "approved") return;

  const { error } = await client.from("hall_of_fame").insert({
    date: day,
    product_id: top.productId,
    best_score: top.bestScore,
    runs_taken: top.runsCount,
  });
  // unique(date) — a concurrent close beat us; that's fine
  if (error && error.code !== "23505") throw error;

  await client
    .from("products")
    .update({ last_won_on: day })
    .eq("id", top.productId);
}
