import type { Metadata } from "next";
import { redirect } from "next/navigation";
import DuelChampionBanner from "@/components/DuelChampionBanner";
import Duels from "@/components/Duels";

// The challenge link: /duels/ABCD drops a challenger straight into the
// join flow for that pit — name (or linked X handle), fight. The page is
// just the duel board with the modal pre-opened, so a dead code degrades
// into "pick another fight" instead of a wall.

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ code: string }>;
}

const CODE_RE = /^[A-Z0-9]{4}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const pit = decodeURIComponent(code).toUpperCase();
  if (!CODE_RE.test(pit)) return { title: "flappybid — the dueling grounds" };
  const title = `⚔ you've been challenged — pit ${pit}`;
  const description =
    "Someone's waiting for you in the duel arena on flappybid.lol. OSRS-style bird duels, all melee — one click and you're in the pit.";
  return {
    title,
    description,
    robots: { index: false, follow: false }, // codes are ephemeral
    openGraph: { title, description, url: `/duels/${pit}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function DuelInvitePage({ params }: Props) {
  const { code } = await params;
  const pit = decodeURIComponent(code).toUpperCase();
  if (!CODE_RE.test(pit)) redirect("/duels");
  return (
    <>
      <DuelChampionBanner />
      <Duels initialJoin={pit} />
    </>
  );
}
