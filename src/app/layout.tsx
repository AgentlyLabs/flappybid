import type { Metadata, Viewport } from "next";
import { Press_Start_2P, VT323 } from "next/font/google";
import Link from "next/link";
import PixelBird from "@/components/PixelBird";
import AnnouncementModal from "@/components/AnnouncementModal";
import ChatPanel from "@/components/ChatPanel";
import HeaderNav from "@/components/HeaderNav";
import SponsorRails from "@/components/SponsorRails";
import "./globals.css";

// static pages re-render at most every 10 min
export const revalidate = 600;

const pressStart = Press_Start_2P({
  weight: "400",
  variable: "--font-press-start",
  subsets: ["latin"],
});

const vt323 = VT323({
  weight: "400",
  variable: "--font-vt323",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "flappybid.lol — the leaderboard money can't buy",
    template: "%s — flappybid.lol",
  },
  description:
    "Enter your product, play Flappy Bird, top score holds #1. The daily champion gets the whole site for a day — then retires undefeated, forever.",
  metadataBase: new URL("https://flappybid.lol"),
  openGraph: {
    siteName: "flappybid.lol",
    type: "website",
    title: "flappybid.lol",
    description:
      "Claim #1 with pure skill. Play Flappy Bird for your product; the daily champion gets showcased to everyone for 24 hours.",
  },
  twitter: {
    card: "summary_large_image",
    title: "flappybid.lol — the leaderboard money can't buy",
    description:
      "Claim #1 with pure skill. Play Flappy Bird for your product; the daily champion gets showcased to everyone for 24 hours.",
  },
};

export const viewport: Viewport = {
  themeColor: "#faf3e0",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${pressStart.variable} ${vt323.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* apply the saved theme before first paint; light is the default */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("fb_theme")==="dark")document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <header className="bg-sky border-b-4 border-ink sticky top-0 z-40">
          <div className="mx-auto max-w-5xl px-4 h-16 flex items-center justify-between gap-4">
            <Link
              href="/"
              className="flex items-center gap-2.5 font-pixel text-xs sm:text-sm"
            >
              <PixelBird className="w-8 h-6" />
              <span>
                flappybid<span className="text-orange-deep">.lol</span>
              </span>
            </Link>
            <HeaderNav />
          </div>
        </header>
        {/* on xl the fixed sponsor rails fill the viewport, and the footer
            (z-30) paints over them by design — so short tabs (rules, hall
            of fame) must keep the footer below the fold or it would sit on
            the bottom cards with no way to scroll them clear */}
        <main className="flex-1 xl:min-h-[calc(100dvh-4rem)]">{children}</main>
        {/* every tab carries the rails; the showcase banners live on their
            own boards — classic on app/page.tsx, duels on app/duels/ */}
        <SponsorRails />
        <ChatPanel />
        {/* after <main>, so at the shared z-50 it paints over open game
            modals instead of under them */}
        <AnnouncementModal />
        {/* relative z-30 lifts the ground above the fixed sponsor rails
            (z-20), so scrolling to the bottom slides the cards under the
            dirt instead of painting them over the footer */}
        <footer className="mt-14 border-t-4 border-ink relative z-30 bg-paper">
          <div className="h-4 bg-grass border-b-4 border-grass-deep" />
          <div className="ground-dirt py-8 text-center px-4">
            <p className="text-xl">
              flappybid.lol — skill is the only currency. New round every day
              at 00:00 UTC.
            </p>
            <p className="text-lg mt-3">
              Questions, a stuck payment, or a sponsor change? DM{" "}
              <a
                href="https://x.com/ahmadafterhours"
                target="_blank"
                rel="noopener"
                className="underline hover:text-orange-deep"
              >
                @ahmadafterhours
              </a>{" "}
              or{" "}
              <a
                href="https://x.com/omarships"
                target="_blank"
                rel="noopener"
                className="underline hover:text-orange-deep"
              >
                @omarships
              </a>
            </p>
            <a
              href="https://agently.dev"
              target="_blank"
              rel="noopener"
              className="mt-6 inline-flex items-center gap-3 font-pixel text-xs sm:text-sm uppercase tracking-wider hover:text-orange-deep"
            >
              <span className="w-3 h-3 bg-[#7c3aed]" />
              <span>Built with Agently</span>
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
