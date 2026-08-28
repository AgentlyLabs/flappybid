import { NextResponse } from "next/server";
import { getHallChampions } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ champions: await getHallChampions() });
}
