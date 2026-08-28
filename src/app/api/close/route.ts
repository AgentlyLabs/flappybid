import { NextRequest, NextResponse } from "next/server";
import { ensureFinalized } from "@/lib/close";
import { utcYesterday } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hit by Vercel Cron at 00:00 UTC (see vercel.json). Guarded by CRON_SECRET.
// Idempotent: the lazy close in the leaderboard route covers missed crons.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const day = utcYesterday();
  await ensureFinalized(day);
  return NextResponse.json({ ok: true, finalized: day });
}
