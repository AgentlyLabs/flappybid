import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { xHandleFrom } from "@/lib/x";
import { costForPieceId } from "@/game/wardrobe";
import { buyCosmetic, walletBalance } from "@/lib/wallet";

export const runtime = "nodejs";

// Buy a wardrobe piece with coins. A spend endpoint, so same-origin + rate
// limit like the rest of the economy. The wallet belongs to a connected X
// account, so a buy needs an X session (whose wallet pays). Pricing is
// server-authoritative — the client names a piece id, never a price; the cost
// comes from the catalog here and the debit + ownership are atomic in
// buy_cosmetic. Re-buying an owned piece is a harmless no-op (returns balance).
const allowed = makeLimiter({ windowMs: 60_000, max: 30, gapMs: 500 });

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let body: { pieceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const pieceId = String(body.pieceId ?? "");
  const cost = pieceId ? costForPieceId(pieceId) : null;
  if (!cost) {
    // unknown piece, or a free one that never needs buying
    return NextResponse.json({ error: "not for sale" }, { status: 400 });
  }

  // the wallet is the X account's — no connection, no coins to spend
  const handle = await xHandleFrom(req);
  if (!handle) {
    return NextResponse.json(
      { error: "connect X to buy pieces", needsX: true },
      { status: 403 }
    );
  }

  const client = db();
  const newBalance = await buyCosmetic(client, handle, pieceId, cost);
  if (newBalance === null) {
    // couldn't grant it — the only failure the RPC reports is "too poor"
    const balance = await walletBalance(client, handle);
    return NextResponse.json(
      { error: "not enough coins", balance },
      { status: 402 }
    );
  }

  return NextResponse.json({ ok: true, pieceId, balance: newBalance });
}
