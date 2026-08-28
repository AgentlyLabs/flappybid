import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rules",
  description:
    "How flappybid.lol works: enter any product free, play unlimited Flappy Bird runs, highest score at 00:00 UTC wins the day and retires undefeated. Every run is verified by a server-side replay.",
  alternates: { canonical: "/rules" },
};

const rules: { title: string; body: string }[] = [
  {
    title: "Enter anything, free, instantly",
    body: "Type your product's URL or an X @handle and you're on the board. No account, no payment, no approval queue. Entering an existing product just lets you fly for it — anyone can add runs to any product.",
  },
  {
    title: "Unlimited runs, best one counts",
    body: "Play Flappy Bird as many times as you want. Your product's daily score is its single best run — nothing you do can lower it, so keep flying.",
  },
  {
    title: "The day ends at 00:00 UTC",
    body: "Highest score when the clock strikes midnight UTC wins the day. Ties go to whoever reached the score first.",
  },
  {
    title: "The champion takes the page",
    body: "The winner is locked into the Hall of Fame forever and gets showcased at the top of the site for the entire next day, with a live counter of every click it sends. That counter is the whole pitch.",
  },
  {
    title: "Champions retire undefeated",
    body: "One win per product, ever. Take a day and you're done competing — your product keeps its Hall of Fame spot and its 24 hours of glory, but it never flies again. Nobody camps #1, and every day crowns somebody new.",
  },
  {
    title: "Cheating doesn't work",
    body: "Every run is replayed on the server, frame by frame, from a server-issued seed. If your submitted inputs don't reproduce your claimed score in real time, the run is thrown away. The board can only be climbed with a steady hand.",
  },
  {
    title: "Coins buy exactly one thing: a second chance",
    body: "Coins are a paid currency — you buy them, you never grind them, and they live on your connected 𝕏 account (that's the wallet in the top-right). Their only use is the revive: spend 50 coins mid-run to respawn where you died and keep the same run alive. One revive per run, so a deep wallet can't buy an infinite score — and the revive is replayed and verified like everything else, so it still has to be flown.",
  },
  {
    title: "Duels settle it head-to-head",
    body: "Skip the daily board entirely and challenge someone to a live melee duel — real-time, weapon in hand, last bird standing wins. Duels have their own board: a win is +1, a loss is −1 (never below zero), and the top duelist gets the banner. Separate ladder, separate glory.",
  },
  {
    title: "Two honest multipliers, one ceiling",
    body: "Share your run on 𝕏, or vote for flappybid on Product Hunt, and every run you fly for the rest of the day counts double on the board. It's the honor system, it stacks on top of your replay-verified score, and it caps at 2x — doing both doesn't make it 4x. Resets at midnight UTC like everything else.",
  },
];

export default function RulesPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: rules.map((rule) => ({
      "@type": "Question",
      name: rule.title,
      acceptedAnswer: { "@type": "Answer", text: rule.body },
    })),
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <h1 className="font-pixel text-xl text-center text-white text-outline leading-relaxed">
        Rules
      </h1>
      <p className="text-center text-xl mt-4 mb-10">
        Nine of them. All load-bearing.
      </p>
      <ol className="flex flex-col gap-5">
        {rules.map((rule, i) => (
          <li key={rule.title} className="pixel-card p-5 flex gap-4">
            <span className="w-9 h-9 shrink-0 border-[3px] border-ink bg-orange text-white flex items-center justify-center font-pixel text-xs">
              {i + 1}
            </span>
            <div>
              <p className="font-pixel text-[11px] leading-relaxed">
                {rule.title}
              </p>
              <p className="text-lg mt-2">{rule.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
