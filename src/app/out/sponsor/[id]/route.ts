import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Outbound redirect for sponsor cards. Counting every click lets the rails
// show sponsors — and would-be sponsors — what a slot actually delivers.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const client = db();
  const { data: sponsor } = await client
    .from("sponsors")
    .select("id, url")
    .eq("id", id)
    .eq("status", "live")
    .maybeSingle();
  if (!sponsor) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // errors ignored so the redirect never breaks (e.g. migration not applied yet)
  await client.rpc("increment_sponsor_clicks", { sid: sponsor.id });

  const target = sponsor.url.startsWith("http")
    ? sponsor.url
    : `https://${sponsor.url}`;
  const url = new URL(target);
  if (!url.searchParams.has("utm_source")) {
    url.searchParams.set("utm_source", "flappybid");
  }
  return NextResponse.redirect(url.toString(), 302);
}
