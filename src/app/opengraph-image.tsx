import { ImageResponse } from "next/og";
import {
  OG_SIZE, INK, SKY, PAPER, GOLD, GOLD_DEEP, ORANGE, MUTED, PIPE, PIPE_LIGHT, PIPE_DARK,
  birdDataUri, ogFonts, fontSpec,
} from "@/lib/og";
import { TopBar } from "@/lib/og-parts";

export const runtime = "nodejs";
export const alt = "flappybid.lol — an ad slot money can't buy";
export const size = OG_SIZE;
export const contentType = "image/png";

// Deliberately static. X caches an unfurled card on its own CDN and there is no
// longer a way to force a refresh, so anything live here would freeze at
// whatever the first crawl happened to catch.

// satori's layout engine positions absolute elements against their IMMEDIATE
// parent, not the nearest positioned ancestor, so these are emitted as direct
// children of the unpadded container rather than wrapped in a component.
function pipes() {
  const spec: Array<{
    side: "left" | "right";
    top?: number;
    bottom?: number;
    height: number;
  }> = [
    { side: "left", top: 0, height: 132 },
    { side: "left", bottom: 50, height: 104 },
    { side: "right", top: 0, height: 96 },
    { side: "right", bottom: 50, height: 120 },
  ];
  return spec.flatMap((p, i) => {
    const x = p.side === "left" ? { left: -18 } : { right: -18 };
    const xCap = p.side === "left" ? { left: -33 } : { right: -33 };
    const y = p.top !== undefined ? { top: p.top } : { bottom: p.bottom };
    const yCap =
      p.top !== undefined
        ? { top: p.top + p.height }
        : { bottom: (p.bottom ?? 0) + p.height };
    return [
      <div
        key={`p${i}`}
        style={{
          position: "absolute",
          ...x,
          ...y,
          width: 104,
          height: p.height,
          backgroundColor: PIPE,
          borderLeft: `7px solid ${INK}`,
          borderRight: `7px solid ${PIPE_DARK}`,
          display: "flex",
        }}
      />,
      <div
        key={`c${i}`}
        style={{
          position: "absolute",
          ...xCap,
          ...yCap,
          width: 134,
          height: 42,
          backgroundColor: PIPE_LIGHT,
          border: `7px solid ${INK}`,
          display: "flex",
        }}
      />,
    ];
  });
}

export default async function Image() {
  const fonts = await ogFonts();
  const pixel = Boolean(fonts.pixel);
  const body = fonts.body ? "VT323" : undefined;

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

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}
        >
          {pipes()}

          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                height: 14,
                backgroundColor: PIPE_LIGHT,
                borderTop: `7px solid ${INK}`,
                borderBottom: `6px solid ${PIPE_DARK}`,
                display: "flex",
              }}
            />
            <div style={{ height: 36, backgroundColor: "#ded895", display: "flex" }} />
          </div>

          {/* padding-bottom keeps the copy clear of X's title chip */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 74px 70px",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={birdDataUri()} width={88} height={66} alt="" />

            <div
              style={{
                display: "flex",
                fontSize: 33,
                letterSpacing: -1,
                marginTop: 16,
              }}
            >
              an ad slot money can&apos;t buy
            </div>
            <div style={{ display: "flex", fontFamily: body, fontSize: 29, marginTop: 12, color: "#4a4638" }}>
              you win it at flappy bird.
            </div>

            {/* Fixed, not live. See the caching note above. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 640,
                marginTop: 16,
                backgroundColor: PAPER,
                border: `7px solid ${INK}`,
                boxShadow: `11px 11px 0 ${INK}`,
                padding: 14,
              }}
            >
              {[
                { rank: "#1", name: "agently.dev", score: "78" },
                { rank: "#2", name: "swipe.agently.dev", score: "61" },
              ].map((r, i) => (
                <div
                  key={r.rank}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: 58,
                    marginTop: i === 0 ? 0 : 8,
                    padding: "0 16px",
                    backgroundColor: i === 0 ? GOLD : SKY,
                    border: `5px solid ${INK}`,
                    ...(i === 0 ? { boxShadow: `0 5px 0 ${GOLD_DEEP}` } : {}),
                  }}
                >
                  <div style={{ display: "flex", fontSize: 19, width: 66, color: i === 0 ? INK : MUTED }}>
                    {r.rank}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      width: 26,
                      height: 26,
                      backgroundColor: i === 0 ? INK : "#cfd2dc",
                      border: `4px solid ${INK}`,
                    }}
                  />
                  <div style={{ display: "flex", flex: 1, fontFamily: body, fontSize: 30, marginLeft: 16 }}>
                    {r.name}
                  </div>
                  <div style={{ display: "flex", fontSize: 24 }}>{r.score}</div>
                </div>
              ))}

              {/* the open slot: the reader, unranked */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: 58,
                  marginTop: 8,
                  padding: "0 16px",
                  backgroundColor: SKY,
                  border: `5px dashed ${ORANGE}`,
                }}
              >
                <div style={{ display: "flex", fontSize: 19, width: 66, color: ORANGE }}>
                  [?]
                </div>
                <div style={{ display: "flex", width: 26, height: 26, border: `4px dashed ${ORANGE}` }} />
                <div
                  style={{
                    display: "flex",
                    flex: 1,
                    fontFamily: body,
                    fontSize: 30,
                    marginLeft: 16,
                    color: ORANGE,
                  }}
                >
                  your-product.com
                </div>
                <div style={{ display: "flex", fontSize: 24, color: ORANGE }}>--</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fontSpec(fonts) }
  );
}
