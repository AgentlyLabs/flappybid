import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live announcements for the site-wide modal. The client filters out the
// ones this browser already dismissed (localStorage), so this just returns
// everything currently active, oldest first — visitors catch up in order.

export async function GET() {
  try {
    const { data, error } = await db()
      .from("announcements")
      .select("id, title, body")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    return NextResponse.json({ announcements: data ?? [] });
  } catch {
    // DB missing/unreachable — no modal rather than a broken page
    return NextResponse.json({ announcements: [] });
  }
}
