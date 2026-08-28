import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PixelBird from "@/components/PixelBird";
import Favicon from "@/components/Favicon";
import { getFlex } from "@/lib/flex";
import { productIcon } from "@/lib/normalize";

export const dynamic = "force-dynamic";

// The shareable flex page. The real payload is the OG card X renders when
// this URL gets posted; the page itself is a challenge to beat the score.

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const flex = await getFlex(decodeURIComponent(slug));
  if (!flex)
    return { title: "flappybid.lol", robots: { index: false, follow: false } };
  const title = flex.wonOn
    ? `${flex.name} won a day on flappybid.lol with ${flex.score}`
    : `${flex.name} scored ${flex.score} on flappybid.lol`;
  const description =
    "The leaderboard money can't buy. Enter your product, play Flappy Bird — top score of the day gets the whole site for 24 hours.";
  const path = `/s/${encodeURIComponent(flex.slug)}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function FlexPage({ params }: Props) {
  const { slug } = await params;
  const flex = await getFlex(decodeURIComponent(slug));
  if (!flex) notFound();

  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <div className="pixel-panel bg-gold p-8">
        <PixelBird className="w-20 h-15 mx-auto mb-6 animate-float" />
        <p className="font-pixel text-[10px] uppercase text-orange-deep">
          {flex.wonOn
            ? `champion — won ${flex.wonOn}, retired undefeated`
            : "high score"}
        </p>
        <p className="font-pixel text-5xl text-white text-outline my-5">
          {flex.score}
        </p>
        <div className="flex items-center justify-center gap-3">
          <span className="icon-frame w-9 h-9 block">
            <Favicon src={productIcon(flex.kind, flex.slug)} alt={flex.name} />
          </span>
          <h1 className="font-pixel text-sm truncate">{flex.name}</h1>
        </div>
      </div>

      <p className="text-xl mt-8">
        Think your product can fly higher? Unlimited runs, no account — the
        day&apos;s top score owns the whole site tomorrow.
      </p>
      <Link
        href="/"
        className="pixel-btn bg-orange text-white text-xs px-8 py-4 inline-block mt-6"
      >
        Beat it
      </Link>
    </div>
  );
}
