import type { SupabaseClient } from "@supabase/supabase-js";

// Coin wallet plumbing. Keyed by the verified X handle
// — coins belong to the account, not the browser, and only exist once someone
// has connected X (see xHandleFrom). Callers pass the exact-case handle; the
// RPCs lower() it for the key and keep the case for display. All writes go
// through service-role RPCs that hold the invariants (balance never negative,
// revive charge atomic with the per-run cap); the browser never touches its own
// balance. Every function degrades quietly if the migration isn't in yet: coins
// are layered on top of scoring, and scoring must never fail on their account.

/** Current coin balance for a handle, 0 if it has no wallet yet (or none). */
export async function walletBalance(
  client: SupabaseClient,
  handle: string | null | undefined
): Promise<number> {
  if (!handle) return 0;
  const { data, error } = await client
    .from("wallets")
    .select("balance")
    .eq("handle_lower", handle.toLowerCase())
    .maybeSingle();
  if (error) return 0; // table missing or read hiccup — treat as empty
  return data?.balance ?? 0;
}

/**
 * Credit coins to a handle (creating the wallet on first credit). Returns the
 * new balance, or null if nothing was credited (no handle, non-positive amount,
 * or the economy isn't migrated in yet). Idempotency is the caller's job — the
 * Stripe webhook credits once per unique session.
 */
export async function creditCoins(
  client: SupabaseClient,
  handle: string | null | undefined,
  amount: number
): Promise<number | null> {
  if (!handle || amount <= 0) return null;
  const { data, error } = await client.rpc("credit_coins", {
    p_handle: handle,
    p_amount: amount,
  });
  if (error) return null;
  return typeof data === "number" ? data : null;
}

/**
 * Atomically charge one revive against a run, debiting the handle's wallet:
 * bumps the run's revive count (only while open and under the cap) and debits
 * the wallet (only if it can cover the cost), all or nothing. Returns the new
 * balance, or null if the revive couldn't be granted (run closed/at cap, or not
 * enough coins — the caller reads the balance separately to tell the player).
 */
export async function spendForRevive(
  client: SupabaseClient,
  handle: string,
  runId: string,
  cost: number,
  cap: number
): Promise<number | null> {
  const { data, error } = await client.rpc("spend_for_revive", {
    p_handle: handle,
    p_run: runId,
    p_cost: cost,
    p_cap: cap,
  });
  if (error) return null;
  return typeof data === "number" ? data : null;
}

/** The paid wardrobe pieces a handle owns (empty if none / not migrated yet). */
export async function ownedCosmetics(
  client: SupabaseClient,
  handle: string | null | undefined
): Promise<string[]> {
  if (!handle) return [];
  const { data, error } = await client
    .from("cosmetics_owned")
    .select("piece_id")
    .eq("handle_lower", handle.toLowerCase());
  if (error) return []; // table missing or read hiccup — treat as owning nothing
  return (data ?? []).map((r) => r.piece_id as string);
}

/**
 * Atomically buy a cosmetic piece for a handle, debiting the wallet and
 * recording ownership all-or-nothing (buy_cosmetic). Idempotent:
 * re-buying an owned piece returns the current balance without charging. Returns
 * the balance after the call, or null if it couldn't be granted (not enough
 * coins, or the economy isn't migrated in yet — the caller reads the balance to
 * tell which). The price is passed by the server from the catalog, never the
 * client.
 */
export async function buyCosmetic(
  client: SupabaseClient,
  handle: string,
  pieceId: string,
  cost: number
): Promise<number | null> {
  const { data, error } = await client.rpc("buy_cosmetic", {
    p_handle: handle,
    p_piece: pieceId,
    p_cost: cost,
  });
  if (error) return null;
  return typeof data === "number" ? data : null;
}
