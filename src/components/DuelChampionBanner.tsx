import { reigningDuelChampion } from "@/lib/duelBoard";
import { productIcon } from "@/lib/normalize";
import DuelCloseCountdown from "./DuelCloseCountdown";
import Favicon from "./Favicon";

/** the champion's mark: their ref link's favicon, else their X avatar —
 *  the same proxy the board rows and the classic banner use */
function championIcon(handle: string, refLink: string | null): string {
  if (refLink) {
    try {
      const host = new URL(refLink).hostname.replace(/^www\./, "");
      if (host.includes(".")) return productIcon("url", host);
    } catch {
      // unparseable — fall back to the avatar
    }
  }
  return productIcon("handle", `@${handle}`);
}

// Black strip above the arena — same silhouette and sticky position as the
// classic showcase banner (ChampionBanner), so the duels tab reads as the
// same site. Yesterday's top duelist reigns until the next close; before
// the first crown the strip advertises the open throne instead of
// collapsing, so the layout doesn't jump the morning a champion appears.
export default async function DuelChampionBanner() {
  const c = await reigningDuelChampion();

  if (!c) {
    return (
      <div className="block bg-ink text-paper sticky top-16 z-30">
        <div className="mx-auto max-w-5xl px-3 sm:px-4 h-20 flex items-center justify-center gap-2.5 sm:gap-5">
          <span className="text-xl sm:text-3xl leading-none shrink-0" aria-hidden>
            👑
          </span>
          <span className="hidden sm:block font-pixel text-[10px] uppercase text-gold shrink-0">
            Duel champion
          </span>
          <span className="font-pixel text-[10px] sm:text-sm leading-tight sm:leading-relaxed line-clamp-2 sm:line-clamp-none min-w-0">
            the crown is unclaimed — today&apos;s top duelist takes it in{" "}
            <DuelCloseCountdown className="text-gold tabular-nums" />
          </span>
        </div>
      </div>
    );
  }

  return (
    // the crown clicks through the tracked redirect — to the champion's ref
    // link if they set one, else their X profile — so the click is counted
    <a
      href={`/out/duel/${encodeURIComponent(c.handle)}`}
      target="_blank"
      rel={c.refLink ? "noopener nofollow" : "noopener"}
      className="block bg-ink text-paper hover:text-gold sticky top-16 z-30"
    >
      <div className="mx-auto max-w-5xl px-3 sm:px-4 h-20 flex items-center justify-center gap-2.5 sm:gap-5">
        <span className="text-xl sm:text-3xl leading-none shrink-0" aria-hidden>
          👑
        </span>
        <span className="hidden sm:block font-pixel text-[10px] uppercase text-gold shrink-0">
          Reigning duel champion
        </span>
        <span className="icon-frame w-9 h-9 sm:w-12 sm:h-12 block border-paper shrink-0">
          <Favicon src={championIcon(c.handle, c.refLink)} alt={`@${c.handle}`} />
        </span>
        <span className="font-pixel text-[10px] sm:text-sm leading-tight truncate min-w-0">
          {c.refLink ? c.refLink.replace(/^https?:\/\//, "").replace(/\/+$/, "") : `@${c.handle}`}
        </span>
        <span className="font-pixel text-xs sm:text-sm text-gold shrink-0">
          · {c.score} pt{c.score === 1 ? "" : "s"}
        </span>
        <span className="hidden sm:block font-pixel text-[10px] uppercase text-paper/80 shrink-0">
          retires undefeated
        </span>
        {/* also arms the midnight refresh that hands the crown to today's
            leader — hidden on mobile so the strip stays a single line */}
        <span className="hidden sm:block font-pixel text-[10px] uppercase text-paper/60 shrink-0">
          next crown in{" "}
          <DuelCloseCountdown className="text-gold tabular-nums" />
        </span>
      </div>
    </a>
  );
}
