import { NextResponse } from "next/server";
import {
  sponsorState,
  SPONSOR_SLOTS_TOTAL,
  SPONSOR_BASE_CENTS,
} from "@/lib/sponsors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await sponsorState());
  } catch {
    // DB missing/unreachable — show empty rails rather than breaking the page
    return NextResponse.json({
      sponsors: [],
      slotsLeft: SPONSOR_SLOTS_TOTAL,
      nextPriceCents: SPONSOR_BASE_CENTS,
    });
  }
}
