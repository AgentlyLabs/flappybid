import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared blacklist plumbing. There are no accounts, so a ban targets the two
// identities we do have: the product (the entry) and the salted IP hash (the
// device). Raw IPs are never stored.
//
// IMPORTANT: all bans are manual. Product ids are public and anyone can
// start a run for any product, so a cheating run only ever proves the
// *submitter* cheated — never the entry it was played "for". A script once
// iterated public product ids submitting deliberate cheats to get innocent
// entries auto-banned, so auto-banning is off entirely: cheat verdicts only
// disqualify the run and store their evidence in runs.cheat_reason for an
// admin to assess. Existing ban rows (product or device) stay enforced via
// isBanned.

export const BAN_MESSAGE =
  "Banned — cheating was detected on this entry or device. Bans are permanent.";

// Behind the Cloudflare proxy (orange-cloud since 2026-08-22) the only
// trustworthy client address is cf-connecting-ip: proxies APPEND to any
// x-forwarded-for the client sends, so the first XFF value is
// attacker-chosen. XFF stays as the fallback for local dev. Same string as
// before for honest traffic, so no stored identity rotates.
export function clientIpFrom(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function ipHashFrom(req: Request): string {
  const ip = clientIpFrom(req);
  // Prefer a dedicated salt over reusing CRON_SECRET (a leaked cron token
  // shouldn't also make the small IPv4 space brute-forceable). The fallback
  // chain keeps existing hashes stable: setting IP_HASH_SALT rotates every
  // stored device identity — bans, votes, careers — so flip it deliberately.
  const salt =
    process.env.IP_HASH_SALT ?? process.env.CRON_SECRET ?? "flappybid";
  return createHash("sha256").update(ip + salt).digest("hex").slice(0, 24);
}

export async function isBanned(
  client: SupabaseClient,
  productId: string,
  ids: {
    ipHashes?: (string | null | undefined)[];
    deviceIds?: (string | null | undefined)[];
  } = {}
): Promise<boolean> {
  const conds = [
    `product_id.eq.${productId}`,
    ...(ids.ipHashes ?? []).filter(Boolean).map((h) => `ip_hash.eq.${h}`),
    ...(ids.deviceIds ?? []).filter(Boolean).map((d) => `device_id.eq.${d}`),
  ];
  const { data } = await client
    .from("bans")
    .select("id")
    .or(conds.join(","))
    .limit(1);
  return (data?.length ?? 0) > 0;
}
