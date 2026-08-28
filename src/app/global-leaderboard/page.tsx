import type { Metadata } from "next";
import { getGlobalBoard } from "@/lib/globalBoard";
import GlobalLeaderboard from "@/components/GlobalLeaderboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Global Leaderboard",
  description:
    "Every product that has ever flown on flappybid.lol, ranked by its best Flappy Bird run of all time. Banned entries excluded, 50 per page.",
  alternates: { canonical: "/global-leaderboard" },
};

export default async function GlobalLeaderboardPage() {
  const initial = await getGlobalBoard(1);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "flappybid.lol Global Leaderboard",
    itemListElement: initial.entries.map((e) => ({
      "@type": "ListItem",
      position: e.rank,
      name: e.name,
      url: `https://flappybid.lol/s/${encodeURIComponent(e.slug)}`,
    })),
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <h1 className="font-pixel text-xl text-center text-white text-outline leading-relaxed">
        Global Leaderboard
      </h1>
      <p className="text-center text-xl mt-4">
        Every product that has ever flown, ranked by its best single run of all
        time. The daily board resets at midnight — this one never does.
      </p>
      <p className="text-center font-pixel text-[10px] tracking-widest uppercase text-muted mt-5 mb-10">
        Built with{" "}
        <a
          href="https://agently.dev?utm_source=flappybid&utm_medium=global-leaderboard"
          className="text-ink underline decoration-2 underline-offset-4"
        >
          Agently
        </a>
      </p>

      <GlobalLeaderboard initial={initial} />
    </div>
  );
}
