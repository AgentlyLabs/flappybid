import { db } from "./db";

export const SPONSOR_SLOTS_TOTAL = 10;
export const SPONSOR_BASE_CENTS = 1000; // $10 for the first slot
export const SPONSOR_STEP_CENTS = 1000; // +$10 every slot sold
export const SPONSOR_BUYOUT_MULT = 1.5; // full board: bumping the oldest costs 1.5× the last sale

export interface SponsorState {
  sponsors: {
    id: string;
    name: string;
    pitch: string;
    url: string;
    clicks: number;
    /** what this slot actually sold for — the rails show it on the card */
    priceCents: number;
  }[];
  slotsLeft: number;
  nextPriceCents: number;
}

// Sponsors go live on payment; 'pending' shouldn't normally occur anymore
// but still counts as sold so a stray row can't reopen a paid slot.
// Slots have no duration — a sponsor stays on the rails until it's the
// oldest card on a full board and a new payment bumps it out.
export async function sponsorState(): Promise<SponsorState> {
  const client = db();

  const [{ data: live }, { count: soldCount }] = await Promise.all([
    client
      .from("sponsors")
      .select("id, name, pitch, url, clicks_count, price_cents")
      .eq("status", "live")
      .order("created_at", { ascending: true }),
    client
      .from("sponsors")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "live"]),
  ]);

  const sold = soldCount ?? 0;
  let nextPriceCents = SPONSOR_BASE_CENTS + SPONSOR_STEP_CENTS * sold;

  // full board: the +$100 ratchet stops and buyouts compound instead — each
  // one costs 1.5× the most recent sale, so incumbents get pricier to evict
  // every time it happens.
  if (sold >= SPONSOR_SLOTS_TOTAL) {
    const { data: lastSale } = await client
      .from("sponsors")
      .select("price_cents")
      .in("status", ["pending", "live"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastSale) {
      // round to whole dollars so the button, Stripe and the DB all agree
      nextPriceCents =
        Math.round((lastSale.price_cents * SPONSOR_BUYOUT_MULT) / 100) * 100;
    }
  }

  return {
    sponsors: (live ?? []).map(({ clicks_count, price_cents, ...s }) => ({
      ...s,
      clicks: clicks_count ?? 0,
      priceCents: price_cents ?? 0,
    })),
    slotsLeft: Math.max(0, SPONSOR_SLOTS_TOTAL - sold),
    nextPriceCents,
  };
}
