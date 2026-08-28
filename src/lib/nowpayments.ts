import crypto from "crypto";

// NOWPayments — the crypto rail for coin packs, the structural twin of the
// Stripe flow: create a hosted invoice with server-authoritative pricing + our
// order reference, redirect the buyer to the hosted checkout, then credit coins
// from a signature-verified IPN callback (see /api/nowpayments/webhook). Coins
// are always re-derived from the catalog by pack_id — the wire never names a
// price.
//
// Two env vars, both optional (like Stripe's): without them the crypto option
// simply reports "not configured". NOWPAYMENTS_API_KEY authenticates invoice
// creation; NOWPAYMENTS_IPN_SECRET verifies the callback HMAC.

const API_BASE = "https://api.nowpayments.io/v1";

export function nowPaymentsApiKey(): string | undefined {
  return process.env.NOWPAYMENTS_API_KEY || undefined;
}

export function nowPaymentsIpnSecret(): string | undefined {
  return process.env.NOWPAYMENTS_IPN_SECRET || undefined;
}

export interface CreateInvoiceInput {
  /** dollars as a string, e.g. "1.99" — NOWPayments quotes crypto against this */
  amountUsd: string;
  /** merchant reference echoed back on every IPN; we pack kind:pack:handle here */
  orderId: string;
  orderDescription: string;
  successUrl: string;
  cancelUrl: string;
  /** absolute URL NOWPayments POSTs payment-status updates to */
  ipnCallbackUrl: string;
}

/**
 * Create a fixed-price NOWPayments invoice. Returns the hosted checkout URL the
 * buyer is sent to, or null if the API key is missing or NOWPayments rejects the
 * request (caller turns null into a friendly error).
 */
export async function createInvoice(
  input: CreateInvoiceInput
): Promise<string | null> {
  const key = nowPaymentsApiKey();
  if (!key) return null;

  try {
    const res = await fetch(`${API_BASE}/invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        price_amount: Number(input.amountUsd),
        price_currency: "usd",
        order_id: input.orderId,
        order_description: input.orderDescription,
        ipn_callback_url: input.ipnCallbackUrl,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { invoice_url?: string };
    return json.invoice_url ?? null;
  } catch {
    return null;
  }
}

// NOWPayments signs the IPN body by ksort-ing the JSON object (recursively) and
// HMAC-SHA512-ing the re-serialized string. JS JSON.stringify emits unescaped
// slashes, matching their JSON_UNESCAPED_SLASHES — so we re-sort and re-stringify
// the parsed payload rather than hashing the raw body.
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Verify a NOWPayments IPN callback. The x-nowpayments-sig header is the hex
 * HMAC-SHA512 of the key-sorted JSON body under the shared IPN secret.
 * Constant-time comparison; false on any mismatch, missing secret, or missing
 * signature. Pass the already-parsed payload object.
 */
export function verifyIpn(
  payload: unknown,
  signature: string | null
): boolean {
  const secret = nowPaymentsIpnSecret();
  if (!secret || !signature || typeof payload !== "object" || payload === null) {
    return false;
  }
  const sorted = JSON.stringify(sortDeep(payload));
  const expected = crypto
    .createHmac("sha512", secret)
    .update(sorted, "utf8")
    .digest("hex");
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
