import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only sponsor moderation: flip a slot's status from the /admin
// dashboard instead of the Supabase UI. 'pending' is deliberately not
// settable — a row only ever leaves that state.
const SETTABLE = new Set(["live", "rejected", "expired"]);

export async function POST(req: NextRequest) {
  if (!isAdminHandle(await xHandleFrom(req))) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let id = "";
  let status = "";
  try {
    const body = await req.json();
    id = String(body.id ?? "");
    status = String(body.status ?? "");
  } catch {
    // fall through to the validation error
  }
  if (!id || !SETTABLE.has(status)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const { error } = await db()
      .from("sponsors")
      .update({ status })
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
