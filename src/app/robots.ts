import type { MetadataRoute } from "next";

// /out/ stays uncrawled so redirect hits never pollute the click counters.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/out/", "/admin"],
    },
    sitemap: "https://flappybid.lol/sitemap.xml",
  };
}
