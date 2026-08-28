import { NextRequest, NextResponse } from "next/server";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { clientIpFrom, ipHashFrom } from "@/lib/ban";
import {
  HUMAN_COOKIE,
  humanCheckEnabled,
  mintHumanPass,
} from "@/lib/human";

export const runtime = "nodejs";

// a real browser needs this once a day; anything hammering it is farming
const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 1_000 });

// Exchange a solved Turnstile token for the fb_human day-pass cookie that
// /api/run/start requires. Verification happens against Cloudflare — the
// token is single-use, so replaying one here is a no-op.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!humanCheckEnabled()) {
    // layer is off: nothing to mint, and run/start isn't asking for it
    return NextResponse.json({ ok: true, disabled: true });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let token = "";
  try {
    token = String((await req.json()).token ?? "");
  } catch {
    // fall through to the validation error
  }
  if (!token || token.length > 4096) {
    return NextResponse.json({ error: "bad token" }, { status: 400 });
  }

  const ip = clientIpFrom(req);
  let degraded = false;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY!,
          response: token,
          ...(ip !== "unknown" ? { remoteip: ip } : {}),
        }),
      }
    );
    const verdict: { success?: boolean } = await res.json();
    if (!verdict.success) {
      return NextResponse.json(
        { error: "human check failed — reload and try again" },
        { status: 403 }
      );
    }
  } catch {
    // Cloudflare unreachable from OUR side (a bot can't trigger this — a
    // bad token still gets a reachable success:false): don't lock every
    // player out over an egress outage, mint the pass and note it
    degraded = true;
  }

  const out = NextResponse.json({ ok: true, ...(degraded ? { degraded } : {}) });
  out.cookies.set(HUMAN_COOKIE, mintHumanPass(ipHash), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60,
    path: "/",
  });
  return out;
}
