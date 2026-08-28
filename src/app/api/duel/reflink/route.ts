import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { duelBanned } from "@/lib/duels";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 1_000 });

// Your ref link: the URL the duel board shows on your row instead of
// @handle. Keyed to the verified X handle, so the link follows the
// account, not the browser. GET reads yours, POST sets it, DELETE
// restores the plain @handle.

/** http(s) only, 200 chars max, must parse; bare domains get https:// */
function cleanRefUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length < 4 || s.length > 200) return null;
  let u: URL;
  try {
    u = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".")) return null;
  return u.toString();
}

export async function GET(req: NextRequest) {
  const handle = await xHandleFrom(req);
  if (!handle) return NextResponse.json({ handle: null, url: null });
  try {
    const { data } = await db()
      .from("duel_ref_links")
      .select("url")
      .eq("handle_lower", handle.toLowerCase())
      .maybeSingle();
    return NextResponse.json({ handle, url: data?.url ?? null });
  } catch {
    return NextResponse.json({ handle, url: null });
  }
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the link isn't going anywhere" },
      { status: 429 }
    );
  }
  const handle = await xHandleFrom(req);
  if (!handle) {
    return NextResponse.json(
      { error: "connect your 𝕏 account first" },
      { status: 401 }
    );
  }
  if (await duelBanned(db(), [ipHash], [deviceIdFrom(req)])) {
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const url = cleanRefUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { error: "that link doesn't parse — http(s) only, 200 chars max" },
      { status: 400 }
    );
  }

  const { error } = await db().from("duel_ref_links").upsert({
    handle_lower: handle.toLowerCase(),
    handle,
    url,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ error: "could not save the link" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, url });
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const handle = await xHandleFrom(req);
  if (!handle) {
    return NextResponse.json(
      { error: "connect your 𝕏 account first" },
      { status: 401 }
    );
  }
  try {
    await db()
      .from("duel_ref_links")
      .delete()
      .eq("handle_lower", handle.toLowerCase());
  } catch {
    // an orphaned link is harmless; the next save overwrites it
  }
  return NextResponse.json({ ok: true });
}
