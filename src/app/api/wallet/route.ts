import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { xHandleFrom } from "@/lib/x";
import { walletBalance } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Your coin balance. The wallet belongs to a connected X account, so a browser
// with no X session has no wallet — `connected: false`, balance 0. Not
// abuse-sensitive (only ever the caller's own wallet), so no same-origin gate;
// GET can't be counted on to carry an Origin header anyway. Rate-limited so it
// can't be hammered.
const allowed = makeLimiter({ windowMs: 60_000, max: 60, gapMs: 250 });

export async function GET(req: NextRequest) {
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }
  const handle = await xHandleFrom(req);
  const balance = await walletBalance(db(), handle);
  return NextResponse.json({ connected: !!handle, handle, balance });
}
