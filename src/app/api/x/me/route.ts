import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sha256, xHandleFrom, X_SESSION_COOKIE } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The chat panel asks who this browser is linked to (GET) and severs the
// link (DELETE). Both key off the HttpOnly session cookie.

export async function GET(req: NextRequest) {
  return NextResponse.json({ handle: await xHandleFrom(req) });
}

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(X_SESSION_COOKIE)?.value;
  if (token) {
    try {
      await db().from("x_connections").delete().eq("token_hash", sha256(token));
    } catch {
      // the cookie still gets cleared; an orphaned row is harmless
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(X_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
