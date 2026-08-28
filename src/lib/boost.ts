import type { SupabaseClient } from "@supabase/supabase-js";

// Daily 2x boosts, both honor-system by design — neither PH nor X exposes a
// "did this visitor really vote/post" API, so the click is the grant:
//   ph_votes  — the homepage button that opens our Product Hunt page
//   x_shares  — the end-game button that opens the X composer
// One click per device per UTC day. The multiplier is applied on top of the
// replay-verified raw score; callers never touch runs.score with it. The two
// grants share one ceiling: either (or both) means 2x, never 4x.

export const PH_URL =
  "https://www.producthunt.com/products/flappy-bid?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-flappy-bid";

export async function boostFor(
  client: SupabaseClient,
  day: string,
  ...ipHashes: (string | null | undefined)[]
): Promise<number> {
  const hashes = ipHashes.filter(Boolean);
  if (!hashes.length) return 1;
  const granted = async (table: string): Promise<boolean> => {
    const { data, error } = await client
      .from(table)
      .select("ip_hash")
      .eq("day", day)
      .in("ip_hash", hashes)
      .limit(1);
    // table missing (migration not applied) or a read hiccup: no boost —
    // scoring must never fail because a promo table did
    if (error) return false;
    return (data?.length ?? 0) > 0;
  };
  const [ph, x] = await Promise.all([granted("ph_votes"), granted("x_shares")]);
  return ph || x ? 2 : 1;
}
