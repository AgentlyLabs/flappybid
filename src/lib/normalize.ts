// Turn whatever the user typed — "crowdreply.io", "https://foo.com/bar",
// "@builder", "builder" — into a canonical product identity.

export interface ProductIdentity {
  kind: "url" | "handle";
  /** unique key: hostname for urls (www stripped), "@name" lowercased for handles */
  slug: string;
  /** display name shown on the board */
  name: string;
  /** where the leaderboard entry links out to */
  url: string;
}

const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

// x.com single-segment paths that are app routes, not profiles
const X_RESERVED = new Set([
  "home", "explore", "notifications", "messages", "search", "settings",
  "i", "compose", "login", "logout", "signup", "tos", "privacy", "about",
  "download", "jobs", "intent", "share", "hashtag", "premium",
]);

function handleIdentity(handle: string): ProductIdentity {
  const h = handle.toLowerCase();
  return {
    kind: "handle",
    slug: "@" + h,
    name: "@" + h,
    url: `https://x.com/${h}`,
  };
}

export function normalizeEntry(
  raw: string,
  opts?: {
    /** keep the query string and hash on `url` — sponsors paid for that exact
     * landing link (referral codes live there); board entries stay canonical */
    keepQuery?: boolean;
  }
): ProductIdentity | null {
  const input = raw.trim();
  if (!input) return null;

  // explicit @handle, or a bare word with no dot that can't be a domain
  const handleMatch = input.match(HANDLE_RE);
  if (input.startsWith("@") || (handleMatch && !input.includes("."))) {
    if (!handleMatch) return null;
    return handleIdentity(handleMatch[1]);
  }

  let candidate = input;
  if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // require a real dot-separated domain, reject localhost/IPs to keep the
  // board clean and the /out redirect safe
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;

  // an X profile URL is really a handle entry — "x.com/foo" and "@foo" must
  // land on the same board slot, showing the handle rather than "x.com"
  if (host === "x.com" || host === "twitter.com" || host === "mobile.x.com") {
    const segs = parsed.pathname.split("/").filter(Boolean);
    const m = segs.length === 1 ? segs[0].match(HANDLE_RE) : null;
    if (m && !X_RESERVED.has(m[1].toLowerCase())) return handleIdentity(m[1]);
  }

  const suffix = opts?.keepQuery ? `${parsed.search}${parsed.hash}` : "";
  return {
    kind: "url",
    slug: host,
    name: host,
    url: `https://${host}${parsed.pathname === "/" ? "" : parsed.pathname}${suffix}`,
  };
}

/** favicon/avatar for a product — served through our same-origin proxy
 * (/api/icon) so the <Favicon> canvas trim can read its pixels */
export function productIcon(
  kind: "url" | "handle",
  slug: string,
  sz: 64 | 128 = 64
): string {
  return `/api/icon?kind=${kind}&slug=${encodeURIComponent(slug)}&sz=${sz}`;
}
