import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { coinsForPurchase } from "@/lib/coins";
import { creditCoins } from "@/lib/wallet";
import { verifyIpn } from "@/lib/nowpayments";

export const runtime = "nodejs";

// NOWPayments IPN — the crypto twin of the Stripe webhook. Fires on every
// payment-status change; we only fulfill once the payment is fully settled
// ('finished'), and only for our own coin invoices (order_id kind). Coins are
// re-derived from the catalog by pack_id and the unique nowpayments_payment_id
// makes redelivery a no-op, exactly like the Stripe side.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-nowpayments-sig");

  let event: {
    payment_id?: string | number;
    payment_status?: string;
    order_id?: string;
    /** the invoiced USD amount (what we set at creation); signed, so trusted */
    price_amount?: string | number;
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Verify against the parsed object (NOWPayments hashes the key-sorted body,
  // not the raw bytes).
  if (!verifyIpn(event, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  // Credit only when the crypto has fully cleared. Earlier states (waiting,
  // confirming, confirmed, sending) are just progress; a redelivered 'finished'
  // is deduped by the unique payment id below.
  if (event.payment_status !== "finished") {
    return NextResponse.json({ received: true, ignored: true });
  }

  // order_id carries kind:pack_id:handle (handle is last and colon-free).
  const [kind, packId, handle] = String(event.order_id ?? "").split(":");
  if (kind !== "flappybid_coins") {
    return NextResponse.json({ received: true, ignored: true });
  }

  // Coins re-derived server-side: a fixed pack from the catalog, a custom buy
  // from the signed invoice price (price_amount is what we set at creation and
  // is covered by the IPN HMAC, so it can't be tampered with).
  const settledCents = Math.round(Number(event.price_amount ?? 0) * 100);
  const coins = coinsForPurchase(String(packId ?? ""), settledCents);
  const paymentId = String(event.payment_id ?? "");
  if (!coins || !handle || !paymentId) {
    return NextResponse.json({ received: true, ignored: true });
  }

  const client = db();
  const { error } = await client.from("coin_purchases").insert({
    provider: "nowpayments",
    nowpayments_payment_id: paymentId,
    handle_lower: handle.toLowerCase(),
    handle,
    pack_id: packId,
    coins,
    price_cents: settledCents,
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
