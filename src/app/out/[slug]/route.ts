import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ipHashFrom } from "@/lib/ban";
import { utcYesterday, utcDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Outbound redirect. When the target is the current champion (yesterday's
// winner, showcased today) the click is counted — that live number is the
// site's best advertisement.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const client = db();
  const { data: product } = await client
    .from("products")
    .select("id, url")
    .eq("slug", decoded)
    .maybeSingle();
  if (!product) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // per-entry click counter on the board; errors ignored so the redirect
  // never breaks (e.g. migration not applied yet)
  await client.rpc("increment_entry_clicks", { pid: product.id, d: utcDay() });

  const yesterday = utcYesterday();
  const { data: champ } = await client
    .from("hall_of_fame")
    .select("product_id")
    .eq("date", yesterday)
    .maybeSingle();

  if (champ?.product_id === product.id) {
    await Promise.all([
      client.rpc("increment_champion_clicks", { d: yesterday }),
      client
        .from("showcase_clicks")
        .insert({ date: utcDay(), ip_hash: ipHashFrom(req) }),
    ]);
  }

  const target = product.url.startsWith("http")
    ? product.url
    : `https://${product.url}`;
  const url = new URL(target);
  if (!url.searchParams.has("utm_source")) {
    url.searchParams.set("utm_source", "flappybid");
  }
  return NextResponse.redirect(url.toString(), 302);
}
