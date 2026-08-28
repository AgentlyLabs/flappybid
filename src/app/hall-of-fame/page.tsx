import type { Metadata } from "next";
import { db } from "@/lib/db";
import { utcYesterday } from "@/lib/day";
import { productIcon } from "@/lib/normalize";
import Favicon from "@/components/Favicon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hall of Fame",
  description:
    "Every flappybid.lol daily champion, forever. One product wins each day by posting the top Flappy Bird score, gets showcased for 24 hours, then retires undefeated.",
  alternates: { canonical: "/hall-of-fame" },
};

interface HofRow {
  date: string;
  best_score: number;
  runs_taken: number;
  clicks_sent: number;
  products: {
    slug: string;
    kind: "url" | "handle";
    name: string;
    url: string;
  };
}

// The newest winner is still reigning — it owns the showcase banner until
// the next close. Only once the next champion takes over does it retire
// into the hall, so the reigning row is split out and not listed.
async function getHall(): Promise<{ retired: HofRow[]; reigning: boolean }> {
  try {
    const { data } = await db()
      .from("hall_of_fame")
      .select(
        "date, best_score, runs_taken, clicks_sent, products(slug, kind, name, url)"
      )
      .order("date", { ascending: false })
      .limit(365);
    const rows = (data as unknown as HofRow[]) ?? [];
    const yesterday = utcYesterday();
    return {
      retired: rows.filter((r) => r.date !== yesterday),
      reigning: rows.some((r) => r.date === yesterday),
    };
  } catch {
    return { retired: [], reigning: false };
  }
}

export default async function HallOfFamePage() {
  const { retired: hall, reigning } = await getHall();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "flappybid.lol Hall of Fame",
    itemListElement: hall.map((row, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: row.products.name,
      url: `https://flappybid.lol/s/${encodeURIComponent(row.products.slug)}`,
    })),
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <h1 className="font-pixel text-xl text-center text-white text-outline leading-relaxed">
        Hall of Fame
      </h1>
      <p className="text-center text-xl mt-4">
        One champion per day, locked in forever. Each earned it the only way
        possible here: by outflying everyone.
      </p>
      <p className="text-center font-pixel text-[10px] tracking-widest uppercase text-muted mt-5 mb-10">
        Built with{" "}
        <a
          href="https://agently.dev?utm_source=flappybid&utm_medium=hall-of-fame"
          className="text-ink underline decoration-2 underline-offset-4"
        >
          Agently
        </a>
      </p>

      {hall.length === 0 ? (
        <div className="text-center py-16 border-[3px] border-dashed border-ink/50">
          <p className="font-pixel text-xs leading-relaxed">
            {reigning ? "No retired champions yet." : "No champions yet."}
          </p>
          <p className="text-xl mt-3">
            {reigning
              ? "The reigning champion is up in the banner. When the next board closes, they retire here forever."
              : "The first day hasn't closed. Tonight at 00:00 UTC, someone makes history."}
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {hall.map((row) => (
            <a
              key={row.date}
              href={row.products.url}
              target="_blank"
              rel="nofollow ugc noopener"
              className="pixel-card p-4 hover:bg-sand/40"
            >
              <div className="flex items-center gap-3">
                <span className="icon-frame w-10 h-10 block">
                  <Favicon
                    src={productIcon(row.products.kind, row.products.slug)}
                    alt={row.products.name}
                  />
                </span>
                <div className="min-w-0">
                  <p className="font-pixel text-[10px] truncate leading-relaxed">
                    {row.products.name}
                  </p>
                  <p className="text-base mt-1">{row.date}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-pixel text-lg text-orange-deep">
                    {row.best_score}
                  </p>
                  <p className="text-base mt-1">
                    {row.clicks_sent.toLocaleString()} clicks
                  </p>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
