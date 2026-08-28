import { db } from "./db";

// Data behind a product's shareable flex card (/s/[slug] + its OG image):
// the best score the product has ever posted, and whether it won a day.

export interface FlexData {
  slug: string;
  kind: "url" | "handle";
  name: string;
  score: number;
  wonOn: string | null;
}

export async function getFlex(slug: string): Promise<FlexData | null> {
  try {
    const client = db();
    const { data: product } = await client
      .from("products")
      .select("id, slug, kind, name, last_won_on")
      .eq("slug", slug)
      .maybeSingle();
    if (!product) return null;

    const { data: top } = await client
      .from("daily_scores")
      .select("best_score")
      .eq("product_id", product.id)
      .order("best_score", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      slug: product.slug,
      kind: product.kind,
      name: product.name,
      score: top?.best_score ?? 0,
      wonOn: product.last_won_on ?? null,
    };
  } catch {
    return null;
  }
}
