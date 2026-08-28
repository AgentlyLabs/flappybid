import { NextRequest, NextResponse } from "next/server";
import { resolvePurchase } from "@/lib/coins";
import { xHandleFrom } from "@/lib/x";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { nowPaymentsApiKey, createInvoice } from "@/lib/nowpayments";

export const runtime = "nodejs";

// Buy coins with crypto (NOWPayments). The exact twin of /coins/checkout,
// swapping Stripe for a hosted crypto invoice: same X-session requirement (coins
// belong to the @handle), same server-authoritative pricing (client names a
// pack, never a price). NOWPayments invoices have no free-form metadata, so the
// pack + handle ride in order_id (kind:pack:handle) for the IPN to credit from.
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

  if (!nowPaymentsApiKey()) {
    return NextResponse.json(
      {
        error:
          "Crypto payments aren't configured yet — pay with card or DM @ahmadafterhours on X.",
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

  // Server-authoritative pricing: a fixed pack or a bounded custom amount.
  const purchase = resolvePurchase(body);
  if (!purchase) {
    return NextResponse.json(
      { error: "pick a pack or an amount between $5 and $500" },
      { status: 400 }
    );
  }

  const origin = req.headers.get("origin") ?? "https://flappybid.lol";
  // order_id is the only reference NOWPayments echoes back on the IPN. `kind`
  // tells it coin buys from anything else; the pack id + handle are what it
  // credits from — a fixed pack re-derives coins from the catalog, a custom buy
  // from the signed invoice price. Handle has no ':' (X handles are word chars),
  // so parsing on the webhook is safe.
  const orderId = `flappybid_coins:${purchase.id}:${handle}`;
  const url = await createInvoice({
    amountUsd: (purchase.priceCents / 100).toFixed(2),
    orderId,
    orderDescription: `flappybid.lol — ${purchase.coins} coins`,
    ipnCallbackUrl: `${origin}/api/nowpayments/webhook`,
    successUrl: `${origin}/?coins=1`,
    cancelUrl: `${origin}/`,
  });

  if (!url) {
    return NextResponse.json(
      { error: "Couldn't start crypto checkout — try again." },
      { status: 502 }
    );
  }

  return NextResponse.json({ url });
}
