import { NextRequest, NextResponse } from "next/server";
import { ipHashFrom } from "@/lib/ban";
import { xHandleFrom } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GIF search for the chat picker, proxied so the Giphy/Tenor keys stay
// server-side. Either service works alone; with both configured the grid
// interleaves the two. X-gated like chat writes (the picker only exists in
// the composer), rate-limited per device, and short-cached per query so a
// popular search doesn't burn API quota. An empty query returns trending.
//
// Each result carries two URLs: `preview` (small, straight from the API)
// for the grid, and `send` — the URL a message stores in gif_url. `send`
// always matches the shapes parseChatGifUrl accepts, which is what lets
// the write path stay a strict whitelist.

const LIMIT = 24; // per service
const Q_MAX = 50;

const WINDOW_MS = 60_000;
const WINDOW_MAX = 20; // searches per minute per device
const recent = new Map<string, number[]>();

function allowed(hash: string): boolean {
  const now = Date.now();
  const stamps = (recent.get(hash) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = stamps.length < WINDOW_MAX;
  if (ok) stamps.push(now);
  recent.set(hash, stamps);
  if (recent.size > 5_000) {
    for (const [k, v] of recent) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW_MS) recent.delete(k);
    }
  }
  return ok;
}

interface Gif {
  id: string;
  preview: string;
  send: string;
  alt: string;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; gifs: Gif[] }>();

async function giphy(q: string, key: string): Promise<Gif[]> {
  const base = q
    ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
    : "https://api.giphy.com/v1/gifs/trending?";
  const res = await fetch(
    `${base}api_key=${key}&limit=${LIMIT}&rating=pg-13`
  );
  if (!res.ok) return [];
  const d = await res.json();
  return ((d.data ?? []) as Record<string, unknown>[]).flatMap((g) => {
    const id = String(g.id ?? "");
    const images = g.images as
      | { fixed_height_small?: { url?: string } }
      | undefined;
    const preview = images?.fixed_height_small?.url;
    if (!/^[A-Za-z0-9]+$/.test(id) || !preview) return [];
    return [
      {
        id: `g:${id}`,
        preview,
        // canonical media URL built from the id — the shape the write
        // path whitelists, with none of the API URL's tracking params
        send: `https://media.giphy.com/media/${id}/200.gif`,
        alt: String(g.title ?? "gif").slice(0, 80),
      },
    ];
  });
}

async function tenor(q: string, key: string): Promise<Gif[]> {
  const base = q
    ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
    : "https://tenor.googleapis.com/v2/featured?";
  const res = await fetch(
    `${base}key=${key}&limit=${LIMIT}&media_filter=tinygif&contentfilter=medium`
  );
  if (!res.ok) return [];
  const d = await res.json();
  return ((d.results ?? []) as Record<string, unknown>[]).flatMap((g) => {
    const formats = g.media_formats as
      | { tinygif?: { url?: string } }
      | undefined;
    const url = formats?.tinygif?.url;
    // tinygif serves as both preview and send; skip anything whose URL
    // wouldn't pass the write-path whitelist rather than store a dud
    if (!g.id || !url || !url.startsWith("https://media.tenor.com/")) {
      return [];
    }
    return [
      {
        id: `t:${g.id}`,
        preview: url,
        send: url,
        alt: String(g.content_description ?? "gif").slice(0, 80),
      },
    ];
  });
}

function interleave(a: Gif[], b: Gif[]): Gif[] {
  const out: Gif[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const giphyKey = process.env.GIPHY_API_KEY;
  const tenorKey = process.env.TENOR_API_KEY;
  if (!giphyKey && !tenorKey) {
    return NextResponse.json(
      { error: "gifs are not configured" },
      { status: 503 }
    );
  }

  // same gate as sending: the picker only exists behind the X-linked
  // composer, so an unlinked caller here is a script, not a user
  if (!(await xHandleFrom(req))) {
    return NextResponse.json(
      { error: "connect your 𝕏 account to chat" },
      { status: 401 }
    );
  }

  if (!allowed(ipHashFrom(req))) {
    return NextResponse.json(
      { error: "slow down — searching too fast" },
      { status: 429 }
    );
  }

  const q = (new URL(req.url).searchParams.get("q") ?? "")
    .trim()
    .slice(0, Q_MAX)
    .toLowerCase();

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ gifs: hit.gifs });
  }

  // a service erroring out just contributes nothing — the other still shows
  const [g, t] = await Promise.all([
    giphyKey ? giphy(q, giphyKey).catch(() => []) : [],
    tenorKey ? tenor(q, tenorKey).catch(() => []) : [],
  ]);
  const gifs = interleave(g, t);

  if (gifs.length > 0) {
    cache.set(q, { at: Date.now(), gifs });
    if (cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now - v.at > CACHE_MS) cache.delete(k);
      }
    }
  }
  return NextResponse.json({ gifs });
}
