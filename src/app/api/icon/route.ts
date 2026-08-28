import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Same-origin favicon proxy. gstatic/unavatar send no CORS headers, so the
// <Favicon> canvas trim can't read pixels when icons load cross-origin —
// proxying them through us keeps the canvas clean. Only two whitelisted
// upstream shapes are reachable (never an arbitrary URL), so this can't be
// used as an open proxy.
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const sz = req.nextUrl.searchParams.get("sz") === "128" ? 128 : 64;

  const upstreams: string[] = [];
  if (kind === "handle" && /^@[A-Za-z0-9_]{1,20}$/.test(slug)) {
    // real X avatar first; fallback=false makes unavatar 404 instead of
    // serving its generic placeholder, so we can fall back to the X logo
    upstreams.push(`https://unavatar.io/x/${slug.slice(1)}?fallback=false`);
    upstreams.push(`https://www.google.com/s2/favicons?domain=x.com&sz=${sz}`);
  } else if (kind === "url" && /^[a-z0-9][a-z0-9.-]{0,250}$/i.test(slug)) {
    upstreams.push(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(slug)}&sz=${sz}`
    );
  }
  if (upstreams.length === 0) {
    return new Response("bad icon request", { status: 400 });
  }

  for (let i = 0; i < upstreams.length; i++) {
    try {
      // a paid unavatar key (sk_…) lifts the 25 req/day anonymous limit;
      // without one the anonymous tier + our CDN caching still work
      const headers: Record<string, string> =
        upstreams[i].startsWith("https://unavatar.io/") &&
        process.env.UNAVATAR_API_KEY
          ? { "x-api-key": process.env.UNAVATAR_API_KEY }
          : {};
      const res = await fetch(upstreams[i], { redirect: "follow", headers });
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "image/png";
      if (!type.startsWith("image/")) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1_000_000) continue;
      // a fallback (i > 0) means the preferred upstream failed, possibly
      // transiently (unavatar rate limit) — cache it briefly so the real
      // avatar comes back on its own, instead of pinning the X logo for days
      const cache =
        i === 0
          ? "public, max-age=86400, s-maxage=604800"
          : "public, max-age=300, s-maxage=300";
      return new Response(buf, {
        headers: { "Content-Type": type, "Cache-Control": cache },
      });
    } catch {
      // try the next upstream
    }
  }
  // no favicon anywhere (Google's faviconV2 404s for sites without one) —
  // serve our top-hat bird instead of a broken image; cache briefly so a
  // favicon the site adds later shows up on its own
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/fallback-icon.svg",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
