import { NextResponse, type NextRequest } from "next/server";
import { getGlobalBoard } from "@/lib/globalBoard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ?page= walks the all-time board 50 at a time. Clamped to a sane ceiling so a
// hostile client can't push an absurd OFFSET at the DB; a page past the real
// end just comes back empty.
export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get("page"));
  const page =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100_000) : 1;
  return NextResponse.json(await getGlobalBoard(page));
}
