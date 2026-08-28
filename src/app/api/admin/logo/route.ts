import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only logo-order moderation: approve or reject a paid logo bid from the
// /admin dashboard. Approval only records the verdict for now — the live swap
// of the in-game logo is handled separately. 'draft' and 'pending' are not
// settable targets: a row is only ever moved *to* approved/rejected.
const SETTABLE = new Set(["approved", "rejected"]);

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
    // only paid orders (pending) or an earlier verdict can be moved — never a
    // still-unpaid 'draft'
    const { error } = await db()
      .from("logo_bids")
      .update({ status })
      .eq("id", id)
      .in("status", ["pending", "approved", "rejected"]);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
