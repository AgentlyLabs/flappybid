import { db } from "./db";

// Coin-wager escrow for the live arena. Thin wrappers over the
// service-role RPCs that hold the invariants: open debits both wallets or
// nothing, settle pays the winner 2× once, refund gives both stakes back once.
// Every function degrades quietly — a wager is layered on top of the fight, and
// a DB hiccup must never take a live pit down with it (the caller settles
// fire-and-forget, and refund_stale_wagers sweeps anything a crash stranded).
//
// NOTE: imports here stay relative — the ws hub (run by tsx via server.ts,
// outside the Next compiler) calls these, and tsx doesn't resolve the @/ alias.
// Same rule as duelBoard.ts.

/**
 * Lock both stakes for a fight. Returns the escrow id on success, or null if
 * either duelist couldn't cover the stake (nothing is debited then) or the DB
 * is away. The caller must refund this id if the fight never happens, and
 * settle/refund it once it resolves.
 */
export async function openDuelWager(
  code: string,
  handleA: string,
  handleB: string,
  amount: number
): Promise<string | null> {
  if (!handleA || !handleB || amount <= 0) return null;
  try {
    const { data, error } = await db().rpc("open_duel_wager", {
      p_code: code,
      p_a: handleA,
      p_b: handleB,
      p_amount: amount,
    });
    if (error) return null;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/** Pay the pot (2× the stake) to the winning handle. Idempotent server-side. */
export async function settleDuelWager(
  wagerId: string,
  winnerHandle: string
): Promise<void> {
  try {
    await db().rpc("settle_duel_wager", { p_id: wagerId, p_winner: winnerHandle });
  } catch {
    // the verdict was already broadcast; refund_stale_wagers backstops a miss
  }
}

/** Return both stakes — a draw, or an aborted lock. Idempotent server-side. */
export async function refundDuelWager(wagerId: string): Promise<void> {
  try {
    await db().rpc("refund_duel_wager", { p_id: wagerId });
  } catch {
    // backstopped by refund_stale_wagers
  }
}

/** Sweep escrows a dead process left open. Fire-and-forget from the hub sweep. */
export async function refundStaleWagers(): Promise<void> {
  try {
    await db().rpc("refund_stale_wagers", {});
  } catch {
    // best effort — runs again next minute
  }
}
