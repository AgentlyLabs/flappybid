import { randomBytes } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

// Long-lived anonymous device cookie. ip_hash alone is a weak identity in
// both directions: CGNAT folds strangers together, and a proxy-rotating bot
// gets a fresh career every run. The cookie is the complement — sticky
// across IP churn for normal browsers, and conspicuous by its absence in a
// wipe-everything bot loop.
//
// It is client-controlled, so it must never be a trust or rate-limit key on
// its own; it only ever *adds* signal next to ip_hash (career profiling,
// ban lookups, vote dedup).

export const DEVICE_COOKIE = "fb_device";
const DEVICE_RE = /^[0-9a-f]{24}$/;

export function deviceIdFrom(req: NextRequest): string | null {
  const v = req.cookies.get(DEVICE_COOKIE)?.value ?? "";
  return DEVICE_RE.test(v) ? v : null;
}

export function newDeviceId(): string {
  return randomBytes(12).toString("hex");
}

export function setDeviceCookie(res: NextResponse, id: string): void {
  res.cookies.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 365 * 24 * 60 * 60,
    path: "/",
  });
}
