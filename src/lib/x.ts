import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";

// X (Twitter) account linking. There are no accounts on the site, so a link
// binds an X handle to a browser: an HttpOnly session cookie holds a random
// token, the x_connections table holds its hash plus the verified handle.
// X access tokens are used once (to read the handle) and never stored.

export const X_SESSION_COOKIE = "fb_x_session";
export const X_OAUTH_COOKIE = "fb_x_oauth";
// /2/users/me needs both scopes; we skip offline.access on purpose — the
// handle is read once during the callback, so no refresh token is wanted
export const X_SCOPES = "users.read tweet.read";

export function xClientCreds(): { id: string; secret: string } | null {
  const id = process.env.X_CLIENT_ID;
  const secret = process.env.X_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 code challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Public origin of this deployment; Railway fronts us, so trust the proxy. */
export function siteOrigin(req: NextRequest): string {
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    "flappybid.lol";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}

export function isXHandle(s: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(s);
}

/**
 * The canonical stored form of a handle if it belongs to a linked account,
 * else null. X handles are case-insensitive, so a DM recipient typed in any
 * case resolves to the exact handle we froze on that account's messages —
 * which is what thread matching (exact eq) needs.
 */
export async function canonicalHandle(handle: string): Promise<string | null> {
  if (!isXHandle(handle)) return null;
  try {
    const { data } = await db()
      .from("x_connections")
      .select("x_handle")
      .ilike("x_handle", handle)
      .limit(1);
    const found = data?.[0]?.x_handle;
    return found && isXHandle(found) ? found : null;
  } catch {
    return null;
  }
}

/** The verified handle linked to this browser's session cookie, if any. */
export async function xHandleFrom(req: NextRequest): Promise<string | null> {
  return xHandleFromToken(req.cookies.get(X_SESSION_COOKIE)?.value);
}

/** Same lookup from a raw cookie value — for server components, which read
 * cookies via next/headers instead of a NextRequest. */
export async function xHandleFromToken(
  token: string | null | undefined
): Promise<string | null> {
  if (!token) return null;
  try {
    const { data } = await db()
      .from("x_connections")
      .select("x_handle")
      .eq("token_hash", sha256(token))
      .limit(1);
    const handle = data?.[0]?.x_handle;
    return handle && isXHandle(handle) ? handle : null;
  } catch {
    // unreadable link reads as "not linked" — chat writes are gated on the
    // handle, so a DB hiccup here refuses the chirp rather than mislabeling it
    return null;
  }
}
