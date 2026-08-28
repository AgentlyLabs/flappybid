import { ImageResponse } from "next/og";
import { dailyBirdImage, fitBird } from "@/lib/og";

// iOS ignores SVG favicons, so the bird gets a rendered PNG touch icon.
// It wears the daily cosmetic; revalidate keeps it rotating instead of
// freezing at whatever fit was live at build time.

export const runtime = "nodejs";
export const revalidate = 3600;
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const bird = dailyBirdImage();
  const dims = fitBird(bird, 150, 150);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#faf3e0",
        }}
      >
        <img src={bird.uri} {...dims} alt="" />
      </div>
    ),
    size
  );
}
