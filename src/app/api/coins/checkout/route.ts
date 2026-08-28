import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { resolvePurchase } from "@/lib/coins";
import { xHandleFrom } from "@/lib/x";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";

export const runtime = "nodejs";

// Buy coins. Coins belong to a connected X account (that's the wallet key), so
// checkout requires an X session. Server-authoritative pricing — the client
// names a pack, never a price — and the handle rides in the session metadata so
// the webhook credits the right account.
const allowed = makeLimiter({ windowMs: 60_000, max: 20, gapMs: 750 });

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  const handle = await xHandleFrom(req);
  if (!handle) {
    return NextResponse.json(
      { error: "connect X to buy coins", needsX: true },
      { status: 403 }
    );
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

  let body: { packId?: string; amountCents?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Server-authoritative pricing: a fixed pack or a bounded custom amount, never
  // a price off the wire.
  const purchase = resolvePurchase(body);
  if (!purchase) {
    return NextResponse.json(
      { error: "pick a pack or an amount between $5 and $500" },
      { status: 400 }
    );
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
          unit_amount: purchase.priceCents,
          product_data: {
            name: `flappybid.lol — ${purchase.coins} coins`,
            description: "In-game coins. Spend them on revives and more.",
          },
        },
      },
    ],
    // `kind` tells the shared-account webhook coin buys from sponsor buys;
    // pack_id + handle are what it credits from. Fixed packs re-derive coins
    // from the catalog by id; a custom buy re-derives from session.amount_total
    // (the real charged amount) — never trusted off the wire.
    metadata: {
      kind: "flappybid_coins",
      pack_id: purchase.id,
      handle,
      coins: String(purchase.coins),
      price_cents: String(purchase.priceCents),
    },
    success_url: `${origin}/?coins=1`,
    cancel_url: `${origin}/`,
  });

  return NextResponse.json({ url: session.url });
}
