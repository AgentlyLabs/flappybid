import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { sponsorState } from "@/lib/sponsors";
import { normalizeEntry } from "@/lib/normalize";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
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

  let body: { name?: string; pitch?: string; url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim().slice(0, 60);
  const pitch = String(body.pitch ?? "").trim().slice(0, 120);
  const site = normalizeEntry(String(body.url ?? ""), { keepQuery: true });
  if (!name || !pitch || !site || site.kind !== "url") {
    return NextResponse.json(
      { error: "Company name, one-line pitch and a valid website are required." },
      { status: 400 }
    );
  }

  // a full board never blocks a sale — paying at 0 slots left buys out the
  // sponsor that has been on the rails the longest (enforced in the webhook)
  const { nextPriceCents } = await sponsorState();

  const origin = req.headers.get("origin") ?? "https://flappybid.lol";
  const stripe = new Stripe(stripeKey);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: nextPriceCents,
          product_data: {
            name: `flappybid.lol sponsor slot — ${name}`,
            description:
              "Yours until a full board buys out your slot. Goes live the moment you pay.",
          },
        },
      },
    ],
    // `kind` lets the webhook ignore checkout events from other apps if the
    // Stripe account is shared
    metadata: {
      kind: "flappybid_sponsor",
      name,
      pitch,
      url: site.url,
      price_cents: String(nextPriceCents),
    },
    success_url: `${origin}/?sponsored=1`,
    cancel_url: `${origin}/`,
  });

  return NextResponse.json({ url: session.url });
}
