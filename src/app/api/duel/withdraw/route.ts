import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";

export const runtime = "nodejs";

const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 500 });

// Pull your own ghost off the board. The owner token minted at post time is
// the only proof of ownership there is (no accounts) — treat it like the
// browser-held secret it is.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let body: { duelId?: unknown; ownerToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const duelId = String(body.duelId ?? "");
  const ownerToken = String(body.ownerToken ?? "");
  if (!duelId || !ownerToken) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const client = db();
  const { data: duel } = await client
    .from("duels")
    .select("id, status")
    .eq("id", duelId)
    .eq("owner_token", ownerToken)
    .maybeSingle();
  if (!duel) {
    return NextResponse.json({ error: "not your ghost" }, { status: 404 });
  }
  if (duel.status === "open") {
    await client.from("duels").update({ status: "closed" }).eq("id", duel.id);
  }
  return NextResponse.json({ ok: true });
}
