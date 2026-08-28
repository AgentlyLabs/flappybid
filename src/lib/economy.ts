// In-game economy tuning, shared by the client (offer UI, coin counter) and
// the server (the revive charge). Coins are a paid currency: they can ONLY be
// bought (see src/lib/coins.ts + /api/coins/checkout), never earned by playing.
// The revive below is the first coin sink; bird skins and duel-arena wagers are
// the next, so treat coins as a general spend currency, not a revive token.

// The revive microtransaction: what one costs, and how many a single run may
// buy. One per run keeps the board mostly a test of skill and caps how much a
// deep wallet can distort a single score.
export const REVIVE_COST = 50;
export const REVIVES_PER_RUN = 1;

// Payload sanity bound for the reviveFrames array at submit — far above
// REVIVES_PER_RUN so raising the cap later doesn't require touching the
// validator, but low enough to reject a junk array outright.
export const MAX_REVIVES = 100;
