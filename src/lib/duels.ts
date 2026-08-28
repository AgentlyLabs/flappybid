import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared plumbing for the duel API routes.
//
// The start token is the duel version of runs.started_at: recording a fight
// script begins with a server-minted, HMAC-signed timestamp bound to the
// device's ip hash, and posting/accepting verifies the script took at least
// its own sim-time in wall clock. Stateless — no row until a script is
// actually submitted.

const TOKEN_TTL_MS = 30 * 60 * 1000; // record + admire the dummy for 30 min

function sign(ms: number, ipHash: string): string {
  const key =
    "fb-duel:" + (process.env.CRON_SECRET ?? process.env.IP_HASH_SALT ?? "flappybid");
  return createHmac("sha256", key)
    .update(`${ms}.${ipHash}`)
    .digest("hex")
    .slice(0, 32);
}

export function mintDuelStart(ipHash: string): string {
  const ms = Date.now();
  return `${ms}.${sign(ms, ipHash)}`;
}

/** The signed start time in ms, or null if missing/forged/expired. */
export function duelStartMs(value: unknown, ipHash: string): number | null {
  if (typeof value !== "string") return null;
  const [msStr, mac] = value.split(".");
  const ms = Number(msStr);
  if (!Number.isFinite(ms) || !mac) return null;
  if (Date.now() - ms > TOKEN_TTL_MS) return null;
  const expect = Buffer.from(sign(ms, ipHash));
  const got = Buffer.from(mac);
  return expect.length === got.length && timingSafeEqual(expect, got)
    ? ms
    : null;
}

// -- input hygiene ----------------------------------------------------------

/** Uppercased board name, or null if it doesn't fit the pit sign. */
export function duelNickname(raw: unknown): string | null {
  const name = String(raw ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9_-]{3,12}$/.test(name) ? name : null;
}

/** One line of trash talk, control characters stripped. */
export function duelTaunt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const taunt = String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 64);
  return taunt.length ? taunt : null;
}

export const DUEL_EXPIRY_HOURS = [24, 72, 168] as const;

export function duelExpiryHours(raw: unknown): number | null {
  const h = Number(raw);
  return (DUEL_EXPIRY_HOURS as readonly number[]).includes(h) ? h : null;
}

// -- bans -------------------------------------------------------------------

/** Device-level bans apply to duels too; there's no product side here. */
export async function duelBanned(
  client: SupabaseClient,
  ipHashes: Array<string | null | undefined>,
  deviceIds: Array<string | null | undefined>
): Promise<boolean> {
  const conds = [
    ...ipHashes.filter(Boolean).map((h) => `ip_hash.eq.${h}`),
    ...deviceIds.filter(Boolean).map((d) => `device_id.eq.${d}`),
  ];
  if (conds.length === 0) return false;
  const { data } = await client
    .from("bans")
    .select("id")
    .or(conds.join(","))
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// -- shared row shapes ------------------------------------------------------

export interface DuelRow {
  id: string;
  status: string;
  mode: string;
  nickname: string;
  taunt: string | null;
  ruleset: unknown;
  script: number[];
  duel_version: number;
  wins: number;
  losses: number;
  draws: number;
  expires_at: string;
  created_at: string;
}

/** The verdict fields duel_matches stores, as the API speaks them. */
export interface DuelVerdict {
  winner: "ghost" | "challenger" | "draw";
  ko: boolean;
  frames: number;
  ghostHp: number;
  challengerHp: number;
  ghostDmg: number;
  challengerDmg: number;
}

/** winner index from duelReplay (ghost is always fighter A) → API word. */
export function verdictWord(winner: number): "ghost" | "challenger" | "draw" {
  return winner === 0 ? "ghost" : winner === 1 ? "challenger" : "draw";
}
