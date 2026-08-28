import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { SPONSOR_SLOTS_TOTAL } from "@/lib/sponsors";
import { coinsForPurchase } from "@/lib/coins";
import { creditCoins } from "@/lib/wallet";

export const runtime = "nodejs";

// checkout.session.completed → fulfill the purchase. Two products flow through
// here (told apart by metadata.kind): sponsor slots and coin packs. No review
// gate; bad actors get banned/expired after the fact instead.
export async function POST(req: NextRequest) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const stripe = new Stripe(stripeKey);
  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature ?? "",
      webhookSecret
    );
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata ?? {};

    // Coin pack: credit the buyer's X-account wallet. Coins are re-derived
    // server-side — a fixed pack from the catalog by id, a custom buy from
    // amount_total (the amount Stripe actually charged) — never read off the
    // wire. The unique stripe_session_id makes redelivery a no-op: the credit
    // fires only on the first successful insert.
    if (meta.kind === "flappybid_coins") {
      const packId = String(meta.pack_id ?? "");
      const handle = String(meta.handle ?? "");
      const chargedCents = Number(session.amount_total ?? 0);
      const coins = coinsForPurchase(packId, chargedCents);
      if (!coins || !handle) {
        return NextResponse.json({ received: true, ignored: true });
      }
      const client = db();
      const { error } = await client.from("coin_purchases").insert({
        handle_lower: handle.toLowerCase(),
        handle,
        pack_id: packId,
        coins,
        price_cents: chargedCents,
        stripe_session_id: session.id,
      });
      if (error && error.code !== "23505") {
        return NextResponse.json({ error: "db error" }, { status: 500 });
      }
      // credit only on first delivery (a duplicate insert trips 23505 above)
      if (!error) {
        await creditCoins(client, handle, coins);
      }
      return NextResponse.json({ received: true });
    }

    // Logo bid: the draft order row already holds the uploaded image (it was
    // too big for metadata), so we just confirm the charge. Flip draft →
    // pending so it surfaces in /admin for review, recording what Stripe
    // actually charged. The `status = draft` guard makes redelivery a no-op:
    // once it's pending (or approved/rejected) the update matches nothing.
    if (meta.kind === "flappybid_logo") {
      const bidId = String(meta.bid_id ?? "");
      if (!bidId) return NextResponse.json({ received: true, ignored: true });
      await db()
        .from("logo_bids")
        .update({
          status: "pending",
          price_cents: Number(session.amount_total ?? meta.price_cents ?? 0),
          stripe_session_id: session.id,
        })
        .eq("id", bidId)
        .eq("status", "draft");
      return NextResponse.json({ received: true });
    }

    // shared Stripe accounts fan out every app's checkouts to this endpoint —
    // only act on our own sessions
    if (meta.kind !== "flappybid_sponsor") {
      return NextResponse.json({ received: true, ignored: true });
    }
    // no duration: a slot stays live until it's the oldest card on a full
    // board and a new payment bumps it out
    const { error } = await db().from("sponsors").insert({
      name: meta.name ?? "unknown",
      pitch: meta.pitch ?? "",
      url: meta.url ?? "",
      price_cents: Number(meta.price_cents ?? 0),
      stripe_session_id: session.id,
      status: "live",
    });
    // unique stripe_session_id makes redelivery idempotent
    if (error && error.code !== "23505") {
      return NextResponse.json({ error: "db error" }, { status: 500 });
    }

    // buyout mechanic: paying on a full board kicks the sponsor that has been
    // on the rails the longest. Only on first delivery (!error), so a Stripe
    // redelivery can't kick twice.
    if (!error) {
      const client = db();
      const { count } = await client
        .from("sponsors")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending", "live"]);
      if ((count ?? 0) > SPONSOR_SLOTS_TOTAL) {
        const { data: oldest } = await client
          .from("sponsors")
          .select("id")
          .eq("status", "live")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (oldest) {
          await client
            .from("sponsors")
            .update({ status: "expired" })
            .eq("id", oldest.id);
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
