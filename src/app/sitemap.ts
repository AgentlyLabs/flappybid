import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

// Every product's flex page (/s/[slug]) is listed — nothing else links to
// them, so this is how they get discovered.

export const revalidate = 3600;

const BASE = "https://flappybid.lol";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "hourly", priority: 1 },
    {
      url: `${BASE}/hall-of-fame`,
      changeFrequency: "daily",
      priority: 0.8,
    },
    { url: `${BASE}/rules`, changeFrequency: "monthly", priority: 0.6 },
  ];

  try {
    const { data } = await db()
      .from("products")
      .select("slug, created_at")
      .order("created_at", { ascending: false })
      .limit(5000);
    for (const p of data ?? []) {
      pages.push({
        url: `${BASE}/s/${encodeURIComponent(p.slug)}`,
        lastModified: new Date(p.created_at),
        changeFrequency: "daily",
        priority: 0.5,
      });
    }
  } catch {
    // DB unreachable — the static pages still get listed
  }

  return pages;
}
