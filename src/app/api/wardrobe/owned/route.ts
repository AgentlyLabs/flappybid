import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { xHandleFrom } from "@/lib/x";
import { ownedCosmetics, walletBalance } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What the wardrobe needs to render: the caller's coin balance and which paid
// pieces they own. Both belong to a connected X account (the wallet key), so a
// browser with no X session owns nothing and has no balance — the free starter
// basics are still wearable client-side without any of this. Only ever reads the
// caller's own account, so no same-origin gate (GET can't be counted on to carry
// Origin anyway); rate-limited so it can't be hammered. Mirrors /api/wallet.
const allowed = makeLimiter({ windowMs: 60_000, max: 60, gapMs: 250 });

export async function GET(req: NextRequest) {
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }
  const handle = await xHandleFrom(req);
  const client = db();
  const [balance, owned] = await Promise.all([
    walletBalance(client, handle),
    ownedCosmetics(client, handle),
  ]);
  return NextResponse.json({ connected: !!handle, balance, owned });
}
