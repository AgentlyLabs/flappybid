import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The DM inbox: one row per person the linked browser has a private thread
// with, carrying the newest message so the panel can show a snippet and work
// out unread counts against its own per-thread read marks. Identity is the
// server-verified handle — you only ever see your own conversations.

// enough recent DMs to surface every active thread; unread is computed
// client-side per thread, so this only needs to be deep enough to catch the
// latest message in each conversation
const SCAN = 300;

export async function GET(req: NextRequest) {
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
      .select("id, body, gif_url, effect, x_handle, recipient, created_at")
      .neq("recipient", "") // DMs only
      .or(`x_handle.eq.${me},recipient.eq.${me}`)
      .order("id", { ascending: false })
      .limit(SCAN);
    if (error) throw error;

    // reduce to the newest message per partner (rows already newest-first)
    const seen = new Set<string>();
    const conversations: {
      partner: string;
      id: number;
      body: string;
      gif_url: string | null;
      effect: string;
      fromMe: boolean;
      created_at: string;
    }[] = [];
    for (const m of data ?? []) {
      const fromMe = m.x_handle === me;
      const partner = fromMe ? m.recipient : m.x_handle;
      if (!partner || seen.has(partner)) continue;
      seen.add(partner);
      conversations.push({
        partner,
        id: m.id,
        body: m.body,
        gif_url: m.gif_url,
        effect: m.effect,
        fromMe,
        created_at: m.created_at,
      });
    }
    return NextResponse.json({ conversations });
  } catch {
    return NextResponse.json({ conversations: null });
  }
}
