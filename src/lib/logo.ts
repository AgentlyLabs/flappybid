// Buying the flappy bird logo. One flat price, paid by card like a sponsor
// slot, but review-gated: payment records a pending order in /admin instead of
// going live. See supabase/migrations/0033_logo_bids.sql.

// $1,000, in cents. Server-authoritative — the client never names a price.
export const LOGO_PRICE_CENTS = 100_000;

// The uploaded logo is stored inline as a base64 data URL (no storage bucket).
// Cap it so a paste-bomb can't fill a row: ~300KB of image is plenty for a
// logo, and its base64 form is ~4/3 of that.
export const LOGO_MAX_DATA_URL_CHARS = 420_000;

const ALLOWED_LOGO_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

// Accept only a well-formed base64 image data URL of an allowed type and size.
// Returns the cleaned value, or null if it isn't one we'll store.
export function validateLogoDataUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > LOGO_MAX_DATA_URL_CHARS) return null;
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  if (!ALLOWED_LOGO_MIME.has(m[1].toLowerCase())) return null;
  // reject an empty / obviously truncated payload
  if (m[2].length < 32) return null;
  return s;
}
