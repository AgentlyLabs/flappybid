import { INK, PAPER, GOLD, birdDataUri } from "./og";

/**
 * Brand strip for the generated cards. It sits at the TOP because X paints its
 * link-title chip across the bottom-left of an unfurled image, which is where
 * a footer strip would be.
 */
export function TopBar({ pixel }: { pixel: boolean }) {
  return (
    <div
      style={{
        height: 84,
        flex: "0 0 auto",
        backgroundColor: INK,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 34px",
        fontFamily: pixel ? "PressStart" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={birdDataUri()} width={44} height={33} alt="" />
        <div style={{ display: "flex", fontSize: 26, marginLeft: 16 }}>
          <span style={{ color: PAPER }}>flappybid</span>
          <span style={{ color: GOLD }}>.lol</span>
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 19, letterSpacing: 2 }}>
        <span style={{ color: "#7d7767" }}>BUILT WITH</span>
        <span style={{ color: PAPER, marginLeft: 10 }}>AGENTLY</span>
      </div>
    </div>
  );
}
