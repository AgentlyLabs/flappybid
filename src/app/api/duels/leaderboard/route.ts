import { NextResponse } from "next/server";
import { getDuelBoard } from "@/lib/duelBoard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Today's duel standings, the reigning duel champion, and the retired hall.
// Reading is also what closes a finished day (lazy close, like /api/leaderboard).
export async function GET() {
  return NextResponse.json(await getDuelBoard());
}
