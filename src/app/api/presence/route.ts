import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { ONLINE_WINDOW_MS } from "@/lib/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Heartbeat: the client pings every 30s with its anonymous visitor id.
// Total visitors = every id ever seen. Both numbers are the real counts.
//
// Every accepted ping writes a permanent visitors row, so the limiter is the
// real cap on inflating the totals. A browser heartbeats 2/min per tab; 30
// per IP hash covers a NAT full of players while holding a scripted loop to
// noise.
const allowed = makeLimiter({ windowMs: 60_000, max: 30 });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let id = "";
  try {
    id = String((await req.json()).id ?? "");
  } catch {
    // fall through to the validation error
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  try {
    const client = db();
    // upsert only touches last_seen on conflict; first_seen keeps its default
    const { error: upsertError } = await client
      .from("visitors")
      .upsert(
        { id: id.toLowerCase(), last_seen: new Date().toISOString() },
        { onConflict: "id" }
      );
    if (upsertError) throw upsertError;

    const sinceIso = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const [onlineRes, totalRes] = await Promise.all([
      client
        .from("visitors")
        .select("id", { count: "exact", head: true })
        .gt("last_seen", sinceIso),
      client.from("visitors").select("id", { count: "exact", head: true }),
    ]);
    if (onlineRes.error || totalRes.error) {
      throw onlineRes.error ?? totalRes.error;
    }

    return NextResponse.json({
      online: onlineRes.count ?? 0,
      total: totalRes.count ?? 0,
    });
  } catch {
    // table missing / DB unreachable — say so instead of inventing numbers;
    // the hero hides the counters on nulls
    return NextResponse.json({ online: null, total: null });
  }
}
