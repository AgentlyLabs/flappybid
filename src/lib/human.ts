import { createHmac, timingSafeEqual } from "crypto";

// Turnstile-backed "this browser passed a human check" cookie. Solving a
// challenge once mints a signed day-pass instead of burning a (single-use)
// Turnstile token per run. The pass is bound to the device hash so a farm
// can't solve one challenge and share the cookie across a botnet — an IP
// change just re-triggers an invisible challenge.
//
// The whole layer is off until TURNSTILE_SECRET_KEY is set, so dev and the
// current prod deploy behave exactly as before.

export const HUMAN_COOKIE = "fb_human";
const TTL_MS = 24 * 60 * 60 * 1000;

export function humanCheckEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

function sign(exp: number, ipHash: string): string {
  const key =
    "fb-human:" +
    (process.env.TURNSTILE_SECRET_KEY ??
      process.env.CRON_SECRET ??
      "flappybid");
  return createHmac("sha256", key)
    .update(`${exp}.${ipHash}`)
    .digest("hex")
    .slice(0, 32);
}

export function mintHumanPass(ipHash: string): string {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(exp, ipHash)}`;
}

export function isHumanPass(
  value: string | undefined,
  ipHash: string
): boolean {
  if (!value) return false;
  const [expStr, mac] = value.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false;
  const expect = Buffer.from(sign(exp, ipHash));
  const got = Buffer.from(mac);
  return expect.length === got.length && timingSafeEqual(expect, got);
}
