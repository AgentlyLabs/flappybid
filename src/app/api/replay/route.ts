import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { utcDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inputs of a product's best run today, so anyone can watch the ghost.
// Only runs that survived server re-simulation ever have flap_frames stored,
// so whatever this returns is a verified run.
export async function GET(req: NextRequest) {
  const productId = req.nextUrl.searchParams.get("productId");
  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const day = utcDay();
  const client = db();
  const first = await client
    .from("runs")
    .select("seed, score, flap_frames, shot_frames, map")
    .eq("product_id", productId)
    .eq("day", day)
    .eq("status", "scored")
    .not("flap_frames", "is", null)
    .order("score", { ascending: false })
    .order("submitted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let run = first.data;
  if (first.error) {
    // runs.map missing (older database) — every run is classic
    ({ data: run } = await client
      .from("runs")
      .select("seed, score, flap_frames")
      .eq("product_id", productId)
      .eq("day", day)
      .eq("status", "scored")
      .not("flap_frames", "is", null)
      .order("score", { ascending: false })
      .order("submitted_at", { ascending: true })
      .limit(1)
      .maybeSingle());
  }

  if (!run) {
    return NextResponse.json({ error: "no replay available" }, { status: 404 });
  }

  // the ghost must re-simulate on the map the run was flown on
  return NextResponse.json({
    seed: Number(run.seed),
    flapFrames: run.flap_frames,
    shootFrames: (run as { shot_frames?: number[] | null }).shot_frames ?? [],
    score: run.score,
    map: (run as { map?: string }).map ?? "classic",
    day,
  });
}
