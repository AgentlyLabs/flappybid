import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { normalizeEntry } from "@/lib/normalize";
import { LOGO_PRICE_CENTS, validateLogoDataUrl } from "@/lib/logo";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";

export const runtime = "nodejs";

// Buy the flappy bird logo. Unlike the sponsor wall this is review-gated: we
// stash the uploaded logo in a 'draft' logo_bids row (the image is way too big
// for Stripe metadata), send the buyer to Stripe for a flat $1,000, and the
// webhook flips the row to 'pending' for the owner to approve in /admin.
const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 1000 });

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return NextResponse.json(
      {
        error:
          "Payments aren't configured yet — DM @ahmadafterhours on X instead.",
      },
      { status: 503 }
    );
  }

  let body: { brand?: string; url?: string; logoDataUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const brand = String(body.brand ?? "").trim().slice(0, 60);
  const logoDataUrl = validateLogoDataUrl(body.logoDataUrl);
  if (!brand || !logoDataUrl) {
    return NextResponse.json(
      { error: "A brand name and a logo image (PNG, JPG, SVG or WebP) are required." },
      { status: 400 }
    );
  }
  // an optional link — if present it has to be a real website
  let url: string | null = null;
  const rawUrl = String(body.url ?? "").trim();
  if (rawUrl) {
    const site = normalizeEntry(rawUrl, { keepQuery: true });
    if (!site || site.kind !== "url") {
      return NextResponse.json(
        { error: "That link doesn't look like a valid website — leave it blank or fix it." },
        { status: 400 }
      );
    }
    url = site.url;
  }

  // Persist the order before payment so the (large) image doesn't have to ride
  // through Stripe. The row is 'draft' until the webhook confirms the charge.
  const { data: row, error: insertErr } = await db()
    .from("logo_bids")
    .insert({ brand, url, logo_data_url: logoDataUrl, price_cents: LOGO_PRICE_CENTS })
    .select("id")
    .single();
  if (insertErr || !row) {
    return NextResponse.json({ error: "Couldn't start the order — try again." }, { status: 500 });
  }

  const origin = req.headers.get("origin") ?? "https://flappybid.lol";
  const stripe = new Stripe(stripeKey);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: LOGO_PRICE_CENTS,
          product_data: {
            name: `flappybid.lol logo — ${brand}`,
            description:
              "Your logo in place of the flappy bird. Reviewed after payment before it goes up.",
          },
        },
      },
    ],
    // `kind` tells the shared-account webhook this from sponsor/coin buys;
    // bid_id links the payment back to the draft row holding the image.
    metadata: {
      kind: "flappybid_logo",
      bid_id: row.id,
      price_cents: String(LOGO_PRICE_CENTS),
    },
    success_url: `${origin}/?logo=1`,
    cancel_url: `${origin}/`,
  });

  return NextResponse.json({ url: session.url });
}
