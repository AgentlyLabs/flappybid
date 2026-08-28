import type { Metadata } from "next";
import DuelChampionBanner from "@/components/DuelChampionBanner";
import Duels from "@/components/Duels";

// Dynamic so the reigning-champion banner turns over the moment the day
// closes (the first request after midnight fires the lazy crown), instead
// of lagging behind the layout's 10-minute revalidate.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "flappybid — the duel arena",
  description:
    "Live OSRS-style bird duels — blades, feathers, eggs and one mega laser. Every win is +1 on the daily board; the day's best bird retires a champion.",
};

export default function DuelsPage() {
  return (
    <>
      <DuelChampionBanner />
      <Duels />
    </>
  );
}
