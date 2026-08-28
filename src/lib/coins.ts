// Coin packs — the whole supply side of the economy, sold through Stripe like
// sponsor slots. Coins are a paid currency: they can ONLY be bought here, never
// earned by playing (see src/lib/economy.ts). They're the flock's single spend
// currency — revives today, bird skins, and (soon) duel-arena wagers — so the
// picker copy stays sink-agnostic. Priced at a flat COINS_PER_USD, anchored so a
// revive (REVIVE_COST = 50 coins) works out to ~$1; the top pack throws in a
// small bonus per dollar.
//
// $5 is the floor on every buy (fixed packs and custom alike): the crypto rails
// (NOWPayments) won't settle a payment worth less than that for most coins, so a
// cheaper option would just error at the hosted checkout. See /api/coins/crypto.
//
// This module is the single source of truth for pricing and is authoritative on
// BOTH sides: the client reads it only to render the picker, while the checkout
// routes (resolvePurchase) and the webhooks (coinsForPurchase) price every buy
// here — the browser names a pack or a dollar amount, never coins or a price.

/** Flat exchange rate. 50 coins = 1 revive ≈ $1. */
export const COINS_PER_USD = 50;
/** $5 floor — below this the crypto rails reject the payment as sub-minimal. */
export const MIN_CUSTOM_CENTS = 500;
/** $500 ceiling on a custom top-up — caps refund/chargeback exposure per buy. */
export const MAX_CUSTOM_CENTS = 50_000;
/** Sentinel pack id for a custom-amount buy (priced from the settled amount). */
export const CUSTOM_PACK_ID = "custom";

export interface CoinPack {
  /** stable id passed to checkout and echoed back in the Stripe metadata */
  id: string;
  coins: number;
  priceCents: number;
  /** short label for the picker button */
  label: string;
  /** tier / value hint under the picker button (sink-agnostic) */
  blurb: string;
}

export const COIN_PACKS: CoinPack[] = [
  { id: "small", coins: 250, priceCents: 500, label: "250 coins", blurb: "starter" },
  { id: "medium", coins: 500, priceCents: 1000, label: "500 coins", blurb: "double up" },
  {
    id: "large",
    // $25 buys 1250 at the flat rate + a 125-coin (10%) bulk bonus
    coins: 1375,
    priceCents: 2500,
    label: "1375 coins",
    blurb: "best value · +10% bonus",
  },
];

export function coinPack(id: string): CoinPack | undefined {
  return COIN_PACKS.find((p) => p.id === id);
}

/** Coins for a dollar amount at the flat rate (custom buys; no bulk bonus). */
export function coinsForCents(cents: number): number {
  return Math.round((cents * COINS_PER_USD) / 100);
}

export interface Purchase {
  /** 'small' | 'medium' | 'large' for a fixed pack, or CUSTOM_PACK_ID */
  id: string;
  coins: number;
  priceCents: number;
}

/**
 * Price a checkout request. The browser sends either a packId (fixed pack) or a
 * custom amountCents — never coins or a trusted price. Returns the server-priced
 * Purchase, or null if it names an unknown pack or an out-of-range amount. This
 * is the pricing gate for both the Stripe and the crypto checkout routes.
 */
export function resolvePurchase(body: {
  packId?: unknown;
  amountCents?: unknown;
}): Purchase | null {
  const named = body.packId != null && body.packId !== "";
  if (named && body.packId !== CUSTOM_PACK_ID) {
    const p = coinPack(String(body.packId));
    return p ? { id: p.id, coins: p.coins, priceCents: p.priceCents } : null;
  }
  const cents = Math.round(Number(body.amountCents));
  if (!Number.isFinite(cents) || cents < MIN_CUSTOM_CENTS || cents > MAX_CUSTOM_CENTS) {
    return null;
  }
  return { id: CUSTOM_PACK_ID, coins: coinsForCents(cents), priceCents: cents };
}

/**
 * Re-derive coins on the webhook side from the pack id and the *actually
 * settled* amount (Stripe's amount_total, or the NOWPayments invoice price).
 * Fixed packs read the catalog and ignore the amount; a custom buy is priced
 * from the settled cents (still bounded to the $5–$500 range). Returns null for
 * an unknown id or an out-of-range custom amount — the caller then no-ops.
 */
export function coinsForPurchase(id: string, settledCents: number): number | null {
  if (id === CUSTOM_PACK_ID) {
    const cents = Math.round(settledCents);
    if (!Number.isFinite(cents) || cents < MIN_CUSTOM_CENTS || cents > MAX_CUSTOM_CENTS) {
      return null;
    }
    return coinsForCents(cents);
  }
  const p = coinPack(id);
  return p ? p.coins : null;
}

// Broadcast on `window` whenever a client changes the wallet (a revive spend,
// a purchase return) so any other coin display on the page — chiefly the header
// balance — updates without polling. detail carries the new balance when known,
// or null to mean "refetch". Mirrors the X_LINK_EVENT pattern.
export const COIN_BALANCE_EVENT = "fb:coins";
