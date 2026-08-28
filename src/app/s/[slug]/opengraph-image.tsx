import { ImageResponse } from "next/og";
import { getFlex } from "@/lib/flex";
import {
  OG_SIZE, INK, SKY, PAPER, GOLD, ORANGE, MUTED,
  dailyBirdImage, fitBird, ogFonts, fontSpec,
} from "@/lib/og";
import { TopBar } from "@/lib/og-parts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "flappybid.lol score card";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const flex = await getFlex(decodeURIComponent(slug));
  const fonts = await ogFonts();

  const name = flex?.name ?? "flappybid.lol";
  const score = String(flex?.score ?? 0);
  const champion = Boolean(flex?.wonOn);
  const pixel = Boolean(fonts.pixel);
  const body = fonts.body ? "VT323" : undefined;

  // the number is the payload: it stays as large as it can without wrapping
  const scoreSize =
    score.length >= 4 ? 150 : score.length === 3 ? 186 : 232;

  const bird = dailyBirdImage();
  const birdDims = fitBird(bird, 236, 260);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: SKY,
          border: `16px solid ${INK}`,
          color: INK,
          fontFamily: pixel ? "PressStart" : undefined,
        }}
      >
        <TopBar pixel={pixel} />

        {/* the bottom-left is left empty: X paints its title chip there */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            padding: "0 54px 74px",
          }}
        >
          {/* today's fit — the card freezes whatever the bird wore on the
              day of the flex, which is part of the fun */}
          <img src={bird.uri} {...birdDims} alt="" />

          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              marginLeft: 46,
              backgroundColor: PAPER,
              border: `7px solid ${INK}`,
              boxShadow: `13px 13px 0 ${INK}`,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "22px 30px 18px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 22,
                  letterSpacing: 4,
                  color: champion ? GOLD : ORANGE,
                }}
              >
                {champion ? "DAILY CHAMPION" : "HIGH SCORE"}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: scoreSize,
                  lineHeight: 1,
                  marginTop: 14,
                }}
              >
                {score}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                backgroundColor: INK,
                padding: "18px 30px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontFamily: body,
                  fontSize: 40,
                  color: PAPER,
                }}
              >
                {name.length > 22 ? name.slice(0, 21) + "…" : name}
              </div>
              <div style={{ display: "flex", fontSize: 20, letterSpacing: 3, color: GOLD }}>
                {champion ? "RETIRED" : "BEAT IT"}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            right: 34,
            bottom: 22,
            display: "flex",
            fontFamily: body,
            fontSize: 28,
            color: MUTED,
          }}
        >
          the leaderboard money can&apos;t buy
        </div>
      </div>
    ),
    { ...size, fonts: fontSpec(fonts) }
  );
}
