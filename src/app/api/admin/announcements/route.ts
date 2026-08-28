import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only announcements: POST pushes a modal onto every visitor's screen,
// PATCH toggles it live/unpublished. Unpublishing stops new impressions;
// republishing resumes them — but visitors who already dismissed it are kept
// away by their own localStorage either way (see AnnouncementModal).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TITLE_MAX = 80;
const BODY_MAX = 1000;

export async function POST(req: NextRequest) {
  const handle = await xHandleFrom(req);
  if (!isAdminHandle(handle)) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let title = "";
  let body = "";
  try {
    const json = await req.json();
    title = String(json.title ?? "").trim();
    body = String(json.body ?? "").trim();
  } catch {
    // fall through to the validation error
  }
  if (!body || body.length > BODY_MAX || title.length > TITLE_MAX) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const { error } = await db()
      .from("announcements")
      .insert({ title, body, created_by: handle });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "create failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!isAdminHandle(await xHandleFrom(req))) {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  let id = "";
  let active: unknown;
  try {
    const json = await req.json();
    id = String(json.id ?? "");
    active = json.active;
  } catch {
    // fall through to the validation error
  }
  if (!UUID_RE.test(id) || typeof active !== "boolean") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const { error } = await db()
      .from("announcements")
      .update({ active })
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
