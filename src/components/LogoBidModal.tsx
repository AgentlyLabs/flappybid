"use client";

import { useState } from "react";
import { LOGO_PRICE_CENTS, LOGO_MAX_DATA_URL_CHARS } from "@/lib/logo";

// Buy the flappy bird logo: upload your own image, pay a flat $1,000 by card,
// and the order lands in /admin for review before it goes up. Mirrors the
// AdvertiseModal shell (scrim + pixel-panel) but with a file upload instead of
// a pitch, and no live-on-payment promise — this one is reviewed first.

const PRICE = Math.round(LOGO_PRICE_CENTS / 100);
// keep the client cap a touch under the server's so a borderline file fails
// here with a friendly message rather than as a 400 after the round-trip
const MAX_BYTES = Math.floor((LOGO_MAX_DATA_URL_CHARS * 3) / 4) - 2048;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

export default function LogoBidModal({ onClose }: { onClose: () => void }) {
  const [brand, setBrand] = useState("");
  const [url, setUrl] = useState("");
  const [logo, setLogo] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pickFile = (file: File | undefined) => {
    setError("");
    if (!file) return;
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("Use a PNG, JPG, SVG, WebP or GIF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That image is too big — keep it under ${Math.floor(MAX_BYTES / 1024)}KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result ?? ""));
    reader.onerror = () => setError("Couldn't read that file — try another.");
    reader.readAsDataURL(file);
  };

  const pay = async () => {
    if (!brand.trim() || !logo) {
      setError("Add a brand name and a logo first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/logo/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, url, logoDataUrl: logo }),
      });
      const out = await res.json();
      if (!res.ok) {
        setError(out.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      window.location.href = out.url;
    } catch {
      setError("Network error — try again.");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      onClick={onClose}
    >
      <div
        className="pixel-panel w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-pixel text-sm leading-relaxed">
            Own the flappy logo
          </h2>
          <button
            onClick={onClose}
            className="font-pixel text-xs hover:text-orange-deep"
            aria-label="Close"
          >
            X
          </button>
        </div>
        <p className="text-lg mt-3">
          Put <span className="text-gold">your logo</span> where the flappy bird
          sits. One flat price. Upload your logo and pay — we review every order
          before it goes up.
        </p>

        <div className="flex flex-col gap-3 mt-5">
          <input
            value={brand}
            onChange={(e) => setBrand(e.target.value.slice(0, 60))}
            placeholder="Brand name"
            className="border-[3px] border-ink bg-paper px-4 py-2.5 text-xl outline-none focus:border-orange-deep"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Link (optional) — e.g. myapp.com"
            className="border-[3px] border-ink bg-paper px-4 py-2.5 text-xl outline-none focus:border-orange-deep"
          />

          <label
            className="flex items-center gap-3 border-[3px] border-ink border-dashed bg-paper px-4 py-3 cursor-pointer hover:border-orange-deep"
          >
            <span className="w-12 h-12 shrink-0 border-2 border-ink bg-white flex items-center justify-center overflow-hidden">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="Your logo" className="max-w-full max-h-full" />
              ) : (
                <span className="font-pixel text-[8px] text-muted">LOGO</span>
              )}
            </span>
            <span className="text-lg min-w-0">
              {logo ? "Choose a different image" : "Upload your logo"}
              <span className="block text-base text-muted">
                PNG, JPG, SVG, WebP · under {Math.floor(MAX_BYTES / 1024)}KB
              </span>
            </span>
            <input
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </label>

          {error && <p className="text-lg text-red">{error}</p>}
          <button
            onClick={pay}
            disabled={busy}
            className="pixel-btn bg-orange text-white text-[10px] py-3"
          >
            {busy ? "Redirecting…" : `Pay $${PRICE.toLocaleString()} with Stripe`}
          </button>
          <p className="text-base text-center text-muted">
            Reviewed before it goes live. Questions? DM{" "}
            <a
              href="https://x.com/ahmadafterhours"
              target="_blank"
              rel="noopener"
              className="underline hover:text-orange-deep"
            >
              @ahmadafterhours
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
