// In-memory abuse guards shared by the write endpoints. Same tradeoff as
// chat's limiter: the site runs as a single Railway instance, so a sliding
// window per device hash needs no shared state, and a restart forgiving
// everyone's window is fine.

interface WindowRule {
  windowMs: number;
  max: number; // hits per window per key
  gapMs?: number; // minimum spacing between consecutive hits
}

export function makeLimiter({ windowMs, max, gapMs = 0 }: WindowRule) {
  const recent = new Map<string, number[]>();
  return function allowed(key: string): boolean {
    const now = Date.now();
    const stamps = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
    const ok =
      stamps.length < max &&
      (stamps.length === 0 || now - stamps[stamps.length - 1] >= gapMs);
    if (ok) stamps.push(now);
    recent.set(key, stamps);
    // keep the map from growing unbounded across many devices
    if (recent.size > 5_000) {
      for (const [k, v] of recent) {
        if (v.length === 0 || now - v[v.length - 1] > windowMs) recent.delete(k);
      }
    }
    return ok;
  };
}

// Every identity signal upstream of the replay layer (cf-connecting-ip,
// x-forwarded-host) is only trustworthy when the request actually came
// through Cloudflare — traffic that reaches the origin directly can spoof
// them all and mint unlimited fresh IP identities. When CF_PROXY_SECRET is
// set, requests must carry the matching x-proxy-secret header that a
// Cloudflare Transform Rule (Rules → Transform → Modify Request Header)
// attaches at the edge; anything that skipped Cloudflare is refused. Off
// until the env and the rule both exist, like the Turnstile layer.
function throughProxy(req: Request): boolean {
  const secret = process.env.CF_PROXY_SECRET;
  return !secret || req.headers.get("x-proxy-secret") === secret;
}

// Browsers attach an Origin header to every fetch POST — same-origin
// included — so a request without one, or with someone else's, didn't come
// from our page. This only filters no-effort scripts (curl can fake any
// header); the real verification is the replay + checkpoint layer. The
// proxy-provenance check rides along here because every abuse-sensitive
// write endpoint already gates on sameOrigin first.
export function sameOrigin(req: Request): boolean {
  if (!throughProxy(req)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  // Railway fronts us, so the public host arrives via x-forwarded-host
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

export const ORIGIN_MESSAGE = "requests must come from the game page";
