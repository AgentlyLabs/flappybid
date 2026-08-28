import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open, joinable pits. The ws hub registers a listing function on
// globalThis at attach time (Next bundles this route separately from the
// hub module, so a plain import would see a different module instance —
// same process, different registries). No function = this server isn't
// running the realtime hub at all, and the board says so.
export async function GET() {
  const fn = (globalThis as Record<string, unknown>).__fbArenaPits as
    | (() => unknown)
    | undefined;
  if (!fn) return NextResponse.json({ live: false, open: [], fights: [] });
  return NextResponse.json({ live: true, ...(fn() as object) });
}
