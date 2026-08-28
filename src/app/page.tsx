import type { Metadata } from "next";
import ChampionBanner from "@/components/ChampionBanner";
import Home from "@/components/Home";
import { getBoard } from "@/lib/board";

// The board must be in the initial HTML — a product's rank is only worth
// something if crawlers and link previews can see it too.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default async function Page() {
  const board = await getBoard();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "flappybid.lol",
    url: "https://flappybid.lol",
    description:
      "The leaderboard money can't buy. Enter your product, play Flappy Bird — top score of the day gets the whole site for 24 hours.",
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* board-only: the reigning champion is a board thing; other tabs
          keep the vertical space (rails live in the root layout) */}
      <ChampionBanner />
      <Home initialBoard={board} />
    </>
  );
}
