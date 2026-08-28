import { db } from "./db";
import { utcYesterday } from "./day";
import { ensureFinalized } from "./close";
import { productIcon } from "./normalize";

// The reigning hall-of-fame winner, shaped for the site-wide showcase banner.
// Falls back to agently.dev until there is a real champion. Everything runs
// on 00:00 UTC: a champion is crowned when the day closes and owns the
// banner until the next close.

export interface BannerChampion {
  /** the site's <title> tag (falls back to the product name) */
  title: string;
  /** favicon url */
  icon: string;
  /** where the banner links — /out/<slug> for champions so clicks count */
  href: string;
  score: number | null;
  /** outbound clicks the showcase has sent so far */
  clicks: number | null;
  isDefault: boolean;
}

const DEFAULT_SLUG = "agently.dev";
const DEFAULT_URL = "https://agently.dev";

export async function bannerChampion(): Promise<BannerChampion> {
  let name = DEFAULT_SLUG;
  let url = DEFAULT_URL;
  let icon = productIcon("url", DEFAULT_SLUG, 128);
  let href = DEFAULT_URL;
  let score: number | null = null;
  let clicks: number | null = null;
  let isDefault = true;

  try {
    // finalize the most recently closed day even if the cron missed
    const yesterday = utcYesterday();
    await ensureFinalized(yesterday);
    const { data } = await db()
      .from("hall_of_fame")
      .select("best_score, clicks_sent, products(slug, kind, name, url)")
      .eq("date", yesterday)
      .maybeSingle();
    const p = data?.products as unknown as
      | { slug: string; kind: "url" | "handle"; name: string; url: string }
      | undefined;
    if (data && p) {
      name = p.name;
      url = p.url;
      icon = productIcon(p.kind, p.slug, 128);
      href = `/out/${encodeURIComponent(p.slug)}`;
      score = data.best_score;
      clicks = data.clicks_sent;
      isDefault = false;
    }
  } catch {
    // DB missing/unreachable — banner still renders with the default
  }

  return {
    title: (await siteTitle(url)) ?? name,
    icon,
    href,
    score,
    clicks,
    isDefault,
  };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** the site's <title> tag; fetch-cached for 30 minutes */
async function siteTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 1800 },
      headers: { "user-agent": "Mozilla/5.0 (compatible; flappybid/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!match) return null;
    const title = match[1]
      .replace(/&[a-z0-9#]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return null;
    return title.length > 70 ? title.slice(0, 67) + "…" : title;
  } catch {
    return null;
  }
}
