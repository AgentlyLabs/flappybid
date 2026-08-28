import { NextRequest, NextResponse } from "next/server";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { db } from "@/lib/db";
import { normalizeEntry } from "@/lib/normalize";
import { utcDay, isRetired } from "@/lib/day";

export const runtime = "nodejs";

// entering is typing a URL and clicking — a handful a minute is already
// generous; more than that is someone stuffing the products table
const allowed = makeLimiter({ windowMs: 60_000, max: 6, gapMs: 2_000 });

// Enter a product (URL or @handle) onto the board. No account, no payment —
// the slug is the identity; entering an existing slug just returns it.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json(
      { error: "slow down — one entry at a time" },
      { status: 429 }
    );
  }

  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const identity = normalizeEntry(String(body.input ?? ""));
  if (!identity) {
    return NextResponse.json(
      { error: "Enter a product URL (yoursite.com) or an X @handle." },
      { status: 400 }
    );
  }

  const client = db();

  let { data: product } = await client
    .from("products")
    .select("id, slug, kind, name, url, last_won_on")
    .eq("slug", identity.slug)
    .maybeSingle();

  if (!product) {
    const { data: inserted, error } = await client
      .from("products")
      .insert({
        slug: identity.slug,
        kind: identity.kind,
        name: identity.name,
        url: identity.url,
      })
      .select("id, slug, kind, name, url, last_won_on")
      .single();
    if (error) {
      // unique race: someone entered the same slug simultaneously — re-read
      const { data: again } = await client
        .from("products")
        .select("id, slug, kind, name, url, last_won_on")
        .eq("slug", identity.slug)
        .maybeSingle();
      if (!again) {
        return NextResponse.json({ error: "could not save" }, { status: 500 });
      }
      product = again;
    } else {
      product = inserted;
    }
  }

  const today = utcDay();
  const { data: score } = await client
    .from("daily_scores")
    .select("best_score, runs_count")
    .eq("product_id", product.id)
    .eq("day", today)
    .maybeSingle();

  return NextResponse.json({
    product: {
      id: product.id,
      slug: product.slug,
      kind: product.kind,
      name: product.name,
      url: product.url,
    },
    retired: isRetired(product.last_won_on),
    wonOn: product.last_won_on,
    today: {
      bestScore: score?.best_score ?? 0,
      runs: score?.runs_count ?? 0,
    },
  });
}
