import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { utcDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Outbound redirect for a duelist's board row — the duels twin of
// /out/[slug]. Counts the click (the board shows the running total) and sends
// the visitor to the duelist's ref link if they've set one, else their X
// profile. Every failure falls through to the X profile so a click never 404s.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  // X handles are [A-Za-z0-9_], 1–20 — anything else can't be a real row
  if (!/^[A-Za-z0-9_]{1,20}$/.test(decoded)) {
    return NextResponse.redirect(new URL("/duels", req.url));
  }

  const client = db();

  // per-row click counter; errors ignored so the redirect never breaks
  // (e.g. the migration hasn't been applied yet)
  try {
    await client.rpc("increment_duel_clicks", { h: decoded, d: utcDay() });
  } catch {
    // count is best-effort; the visitor still gets where they're going
  }

  // the ref link is the destination when set, else the X profile
  let target = `https://x.com/${decoded}`;
  try {
    const { data } = await client
      .from("duel_ref_links")
      .select("url")
      .eq("handle_lower", decoded.toLowerCase())
      .maybeSingle();
    if (data?.url) target = data.url;
  } catch {
    // no link (or table) — the X profile stands in
  }

  let url: URL;
  try {
    url = new URL(target.startsWith("http") ? target : `https://${target}`);
  } catch {
    return NextResponse.redirect(`https://x.com/${decoded}`, 302);
  }
  if (!url.searchParams.has("utm_source")) {
    url.searchParams.set("utm_source", "flappybid");
  }
  return NextResponse.redirect(url.toString(), 302);
}
