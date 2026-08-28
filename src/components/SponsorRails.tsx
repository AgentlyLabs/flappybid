"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SponsorRail, AdvertiseModal, type SponsorData } from "./Sponsors";

// Site-wide sponsor rails, mounted once in the root layout: fixed to the
// viewport edges on xl+ so every tab (board, duels, rules, hall of fame)
// carries the ads — sponsors bought eyeballs, not one page. Below xl the
// rails stay hidden as before; the board's carousel covers mobile. Home
// fetches its own sponsor copy for the wall/carousel; this endpoint is
// cheap enough that the double read doesn't matter. Admin is the one page
// that isn't a sponsor surface, so the rails sit out there.
export default function SponsorRails() {
  const pathname = usePathname();
  const onAdmin = pathname === "/admin" || pathname?.startsWith("/admin/");
  const [data, setData] = useState<SponsorData | null>(null);
  const [advertising, setAdvertising] = useState(false);

  useEffect(() => {
    if (onAdmin) return;
    fetch("/api/sponsors")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, [onAdmin]);

  if (onAdmin) return null;

  return (
    <>
      {/* z-20: under the header (z-40), banner (z-30) and every modal (z-50).
          top AND bottom pin the rail to the viewport, so the cards inside can
          flex to whatever height the screen actually has */}
      <div className="hidden xl:block fixed left-4 top-40 bottom-4 z-20">
        <SponsorRail
          side="left"
          data={data}
          onAdvertise={() => setAdvertising(true)}
        />
      </div>
      <div className="hidden xl:block fixed right-4 top-40 bottom-4 z-20">
        <SponsorRail
          side="right"
          data={data}
          onAdvertise={() => setAdvertising(true)}
        />
      </div>
      {advertising && (
        <AdvertiseModal data={data} onClose={() => setAdvertising(false)} />
      )}
    </>
  );
}
