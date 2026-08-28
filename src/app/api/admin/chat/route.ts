import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only chat moderation: hard-delete a message. The panel just polls,
// so the message drops out of everyone's view within a cycle.

export async function DELETE(req: NextRequest) {
  if (!isAdminHandle(await xHandleFrom(req))) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let id = 0;
  try {
    id = Number((await req.json()).id);
  } catch {
    // fall through to the validation error
  }
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const { error } = await db().from("chat_messages").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
