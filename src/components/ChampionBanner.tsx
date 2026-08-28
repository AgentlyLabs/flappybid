import { bannerChampion } from "@/lib/champion";
import Favicon from "./Favicon";

// Site-wide black strip above the header showcasing yesterday's champion.
export default async function ChampionBanner() {
  const c = await bannerChampion();

  return (
    <a
      href={c.href}
      target="_blank"
      rel="noopener"
      className="block bg-ink text-paper hover:text-gold sticky top-16 z-30"
    >
      <div className="mx-auto max-w-5xl px-3 sm:px-4 h-20 flex items-center justify-center gap-2.5 sm:gap-5">
        <span className="text-xl sm:text-3xl leading-none shrink-0" aria-hidden>
          👑
        </span>
        <span className="hidden sm:block font-pixel text-[10px] uppercase text-gold shrink-0">
          {c.isDefault ? "Champion showcase" : "Reigning champion"}
        </span>
        <span className="icon-frame w-9 h-9 sm:w-12 sm:h-12 block border-paper shrink-0">
          <Favicon src={c.icon} />
        </span>
        <span className="font-pixel text-[10px] sm:text-sm leading-tight sm:leading-relaxed line-clamp-2 sm:line-clamp-none sm:truncate min-w-0">
          {c.title}
        </span>
        {c.score !== null && (
          <span className="font-pixel text-xs sm:text-sm text-gold shrink-0">
            · {c.score}
          </span>
        )}
        {c.clicks !== null && (
          <span className="hidden sm:block font-pixel text-[10px] uppercase text-paper/80 shrink-0">
            {c.clicks.toLocaleString()} click{c.clicks === 1 ? "" : "s"} sent
          </span>
        )}
      </div>
    </a>
  );
}
