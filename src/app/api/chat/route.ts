import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { BAN_MESSAGE, ipHashFrom } from "@/lib/ban";
import {
  CHAT_COLORS,
  NUDGE_EFFECT,
  parseChatEffect,
  parseChatFit,
  parseChatGifUrl,
} from "@/lib/chat";
import { canonicalHandle, isXHandle, xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Chat. The public room's reads are open to everyone (newest 50 messages);
// writes require a verified linked X account, are validated, rate-limited per
// device hash, and refused for banned devices. Bodies are rendered as plain
// text client-side, so no markup/link surface here.
//
// A message can also be a private DM: pass ?with=<handle> to GET to read the
// thread between the linked browser and that handle, or a `recipient` on POST
// to send one. Both ends must be linked X accounts, and only the two of them
// can read the thread — the public feed reads recipient='' and never sees it.

const MAX_MESSAGES = 50;
const NAME_MAX = 20;
const BODY_MAX = 240;

// columns every rendered message carries, public or private
const SELECT =
  "id, name, body, seed, fit, color, effect, body_color, gif_url, x_handle, recipient, created_at";

// Sliding-window rate limit, in memory — the site runs as a single Railway
// instance, so this doesn't need to be shared state. A restart forgiving
// everyone's window is fine.
const WINDOW_MS = 60_000;
const WINDOW_MAX = 15; // messages per minute per device
const GAP_MS = 2_000; // and no more than one every 2s
const recent = new Map<string, number[]>();

// nudges shake every open panel, so they get their own much slower lane on
// top of the normal window
const NUDGE_GAP_MS = 30_000;
const lastNudge = new Map<string, number>();

function allowed(hash: string): boolean {
  const now = Date.now();
  const stamps = (recent.get(hash) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok =
    stamps.length < WINDOW_MAX &&
    (stamps.length === 0 || now - stamps[stamps.length - 1] >= GAP_MS);
  if (ok) stamps.push(now);
  recent.set(hash, stamps);
  // keep the map from growing unbounded across many devices
  if (recent.size > 5_000) {
    for (const [k, v] of recent) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW_MS) recent.delete(k);
    }
  }
  return ok;
}

export async function GET(req: NextRequest) {
  // ?with=<handle> reads a private thread instead of the public room
  const withParam = req.nextUrl.searchParams.get("with");
  if (withParam) return thread(req, withParam);

  try {
    const { data, error } = await db()
      .from("chat_messages")
      .select(SELECT)
      .eq("recipient", "") // public room only — DMs never surface here
      .order("id", { ascending: false })
      .limit(MAX_MESSAGES);
    if (error) throw error;
    return NextResponse.json({ messages: (data ?? []).reverse() });
  } catch {
    // table missing / DB unreachable — the panel shows a warming-up note
    return NextResponse.json({ messages: null });
  }
}

// The DM thread between the linked browser and `other`: both directions of
// the pair, newest 50, oldest-first for display. Only the two participants
// can read it — identity is the server-verified handle, never a param.
async function thread(req: NextRequest, other: string) {
  if (!isXHandle(other)) {
    return NextResponse.json({ error: "bad handle" }, { status: 400 });
  }
  const me = await xHandleFrom(req);
  if (!me) {
    return NextResponse.json(
      { error: "connect your 𝕏 account to read DMs" },
      { status: 401 }
    );
  }
  try {
    const { data, error } = await db()
      .from("chat_messages")
      .select(SELECT)
      // handles are [A-Za-z0-9_]{1,15} (validated above), safe to inline
      .or(
        `and(x_handle.eq.${me},recipient.eq.${other}),and(x_handle.eq.${other},recipient.eq.${me})`
      )
      .order("id", { ascending: false })
      .limit(MAX_MESSAGES);
    if (error) throw error;
    return NextResponse.json({ messages: (data ?? []).reverse() });
  } catch {
    return NextResponse.json({ messages: null });
  }
}

// one line, printable characters only (controls + zero-width chars stripped)
function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export async function POST(req: NextRequest) {
  let raw: {
    name?: unknown;
    body?: unknown;
    seed?: unknown;
    fit?: unknown;
    color?: unknown;
    effect?: unknown;
    bodyColor?: unknown;
    gif?: unknown;
    nudge?: unknown;
    recipient?: unknown;
  };
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // a recipient turns this into a private DM. Nudges are a public-room event
  // (they shake every open panel), so they can't be private.
  const dm =
    typeof raw.recipient === "string" && raw.recipient.trim().length > 0;

  // a nudge is a bodiless event message — the client renders the "sent a
  // nudge" line and shakes open panels when one lands
  const nudge = !dm && raw.nudge === true;
  const name = clean(raw.name, NAME_MAX);
  const body = nudge ? "" : clean(raw.body, BODY_MAX);
  // a picker gif rides along with (or instead of) the text. Unlike the
  // fit/effect degrade-to-plain policy, a malformed URL refuses the whole
  // message — silently dropping the gif would send bare text the user
  // didn't mean to send
  const gif = nudge ? "" : parseChatGifUrl(raw.gif);
  if (!nudge && typeof raw.gif === "string" && raw.gif && !gif) {
    return NextResponse.json({ error: "bad gif" }, { status: 400 });
  }
  if (!body && !gif && !nudge) {
    return NextResponse.json({ error: "bad message" }, { status: 400 });
  }

  const hash = ipHashFrom(req);

  if (nudge) {
    const now = Date.now();
    if (now - (lastNudge.get(hash) ?? 0) < NUDGE_GAP_MS) {
      return NextResponse.json(
        { error: "easy on the nudges — one every 30s" },
        { status: 429 }
      );
    }
    lastNudge.set(hash, now);
    if (lastNudge.size > 5_000) {
      for (const [k, t] of lastNudge) {
        if (now - t > NUDGE_GAP_MS) lastNudge.delete(k);
      }
    }
  }

  // avatar seed: whatever the browser picked, or a stable per-device
  // fallback so a client without one still gets a consistent bird
  const rawSeed = Number(raw.seed);
  const seed =
    Number.isInteger(rawSeed) && rawSeed > 0 && rawSeed < 2_147_483_647
      ? rawSeed
      : (parseInt(hash.slice(0, 8), 16) % 2_147_483_646) + 1;

  // wardrobe fit + name color: stored only when they parse as real pieces /
  // palette colors; anything else degrades to the seed bird and hash color
  const fitStr = typeof raw.fit === "string" ? raw.fit : "";
  const fit = parseChatFit(fitStr) ? fitStr : "";
  const color = CHAT_COLORS.includes(String(raw.color)) ? String(raw.color) : "";

  // text effect + body color: same degrade-to-plain policy as the fit
  const effect = nudge ? NUDGE_EFFECT : parseChatEffect(raw.effect);
  const bodyColor =
    !nudge && CHAT_COLORS.includes(String(raw.bodyColor))
      ? String(raw.bodyColor)
      : "";
  if (!allowed(hash)) {
    return NextResponse.json(
      { error: "slow down — one chirp at a time" },
      { status: 429 }
    );
  }

  try {
    const client = db();
    const { data: ban } = await client
      .from("bans")
      .select("id")
      .eq("ip_hash", hash)
      .limit(1);
    if ((ban?.length ?? 0) > 0) {
      return NextResponse.json({ error: BAN_MESSAGE }, { status: 403 });
    }

    // chat is X-gated: the verified handle (never client-supplied) is the
    // only identity allowed to write; it's frozen onto the message
    const xHandle = await xHandleFrom(req);
    if (!xHandle) {
      return NextResponse.json(
        { error: "connect your 𝕏 account to chat" },
        { status: 401 }
      );
    }

    // resolve a DM recipient to the real, linked account it addresses; a
    // stranger who never joined can't be messaged, and you can't DM yourself
    let recipient = "";
    if (dm) {
      const target = (raw.recipient as string).trim();
      recipient = (await canonicalHandle(target)) ?? "";
      if (!recipient) {
        return NextResponse.json(
          { error: "that handle hasn't joined bird chat" },
          { status: 404 }
        );
      }
      if (recipient.toLowerCase() === xHandle.toLowerCase()) {
        return NextResponse.json(
          { error: "you can't DM yourself" },
          { status: 400 }
        );
      }
    }

    const { error } = await client
      .from("chat_messages")
      .insert({
        // legacy anonymous names still render on old rows; new rows display
        // as @handle, so the name is just a fallback label
        name: name.length >= 2 ? name : xHandle,
        body,
        seed,
        fit,
        color,
        effect,
        body_color: bodyColor,
        gif_url: gif,
        x_handle: xHandle,
        recipient,
        ip_hash: hash,
      });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "chat is unavailable" }, { status: 503 });
  }
}
