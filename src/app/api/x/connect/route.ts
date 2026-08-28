import { NextRequest, NextResponse } from "next/server";
import {
  codeChallenge,
  randomToken,
  siteOrigin,
  xClientCreds,
  X_OAUTH_COOKIE,
  X_SCOPES,
} from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kicks off the X OAuth 2.0 PKCE flow: park state + verifier in a short-lived
// HttpOnly cookie, hand the browser to x.com. X sends it back with a code to
// /api/x/callback.

export async function GET(req: NextRequest) {
  const creds = xClientCreds();
  if (!creds) {
    return NextResponse.json(
      { error: "X linking isn't configured yet." },
      { status: 503 }
    );
  }

  const origin = siteOrigin(req);
  const state = randomToken(16);
  const verifier = randomToken(32);

  // where to land after the round trip — a same-origin path only (the
  // duel invite pages use this to come back to their pit), never a full
  // URL, so the callback can't be steered off-site
  const rawNext = req.nextUrl.searchParams.get("next") ?? "";
  const next = /^\/[a-zA-Z0-9/_-]*$/.test(rawNext) ? rawNext : "/";

  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.id);
  url.searchParams.set("redirect_uri", `${origin}/api/x/callback`);
  url.searchParams.set("scope", X_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");

  const res = NextResponse.redirect(url);
  // the encoded path never contains "." — the callback splits on it
  res.cookies.set(
    X_OAUTH_COOKIE,
    `${state}.${verifier}.${encodeURIComponent(next)}`,
    {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.startsWith("https"),
      path: "/api/x",
      maxAge: 600,
    }
  );
  return res;
}
