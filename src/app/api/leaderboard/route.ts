import { NextResponse, type NextRequest } from "next/server";
import { getBoard } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ?limit= lets "load more" page past the default 100 — clamped (matching
// LEADERBOARD_HARD_CAP in Home.tsx) so a hostile client can't ask the DB
// for the world
export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 100;
  return NextResponse.json(await getBoard(limit));
}
