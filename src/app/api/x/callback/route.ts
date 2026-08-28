import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ipHashFrom } from "@/lib/ban";
import {
  isXHandle,
  randomToken,
  sha256,
  siteOrigin,
  xClientCreds,
  X_OAUTH_COOKIE,
  X_SESSION_COOKIE,
} from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// X sends the browser back here after the user approves (or bails). Exchange
// the code, read the handle once via /2/users/me, store handle + session-token
// hash, and drop the X tokens on the floor. Every exit lands back where the
// flow started (a same-origin path parked in the state cookie — duel invite
// pages use it; the homepage otherwise) with a ?x= flag.

function home(req: NextRequest, flag: string, next = "/"): NextResponse {
  const path = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${siteOrigin(req)}${path}?x=${flag}`);
}

export async function GET(req: NextRequest) {
  const creds = xClientCreds();
  if (!creds) return home(req, "error");

  const params = req.nextUrl.searchParams;
  const [state, verifier, nextEnc] = (
    req.cookies.get(X_OAUTH_COOKIE)?.value ?? ""
  ).split(".");
  let next = "/";
  try {
    next = decodeURIComponent(nextEnc ?? "") || "/";
  } catch {
    // a mangled cookie just lands on the homepage
  }
  const code = params.get("code");

  // "cancel" on X, a stale cookie, or a state mismatch (forged/replayed link)
  if (!code || !state || !verifier || params.get("state") !== state) {
    return home(req, params.get("error") ? "denied" : "error", next);
  }

  try {
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${creds.id}:${creds.secret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${siteOrigin(req)}/api/x/callback`,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
    const { access_token: accessToken } = await tokenRes.json();

    const meRes = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) throw new Error(`users/me ${meRes.status}`);
    const me = await meRes.json();
    const xId = String(me?.data?.id ?? "");
    const handle = String(me?.data?.username ?? "");
    if (!xId || !isXHandle(handle)) throw new Error("bad profile");

    const client = db();
    // a re-link from this browser replaces its old session row
    const old = req.cookies.get(X_SESSION_COOKIE)?.value;
    if (old) {
      await client
        .from("x_connections")
        .delete()
        .eq("token_hash", sha256(old));
    }

    const token = randomToken(32);
    const { error } = await client.from("x_connections").insert({
      token_hash: sha256(token),
      x_id: xId,
      x_handle: handle,
      ip_hash: ipHashFrom(req),
    });
    if (error) throw error;

    const res = home(req, "connected", next);
    res.cookies.set(X_OAUTH_COOKIE, "", { path: "/api/x", maxAge: 0 });
    res.cookies.set(X_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: siteOrigin(req).startsWith("https"),
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  } catch {
    return home(req, "error", next);
  }
}
