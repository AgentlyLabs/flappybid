"use client";

import { useCallback, useEffect, useState } from "react";
import { COIN_PACKS, COIN_BALANCE_EVENT } from "@/lib/coins";
import CoinIcon from "./CoinIcon";
import { X_LINK_EVENT } from "./XConnectButton";

// Header coin wallet — shown only when an X account is connected, since the
// wallet belongs to the @handle (coins follow the account, not the browser).
// Clicking it opens the pack picker (coins are bought, never earned, so a
// connected user at 0 needs a way to act).
//
// The balance refreshes on mount, when the tab regains focus (catches a
// purchase completed in the Stripe tab), on return from checkout (?coins=1),
// and whenever another component broadcasts COIN_BALANCE_EVENT (e.g. a revive
// spend in the game modal). It hides immediately on X disconnect (X_LINK_EVENT).
export default function CoinBalance() {
  const [connected, setConnected] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Which rail the buy buttons use. Both endpoints take the same body ({ packId }
  // or { amountCents }) and return a hosted-checkout { url }, so the buttons
  // don't change — only where they POST. "card" → Stripe, "crypto" → NOWPayments.
  const [method, setMethod] = useState<"card" | "crypto">("card");
  // Custom top-up amount in whole dollars (string so the field can be empty).
  const [customUsd, setCustomUsd] = useState("");

  const refresh = useCallback(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => {
        setConnected(!!d?.connected);
        if (typeof d?.balance === "number") setBalance(d.balance);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onCoins = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "number") setBalance(detail);
      else refresh();
    };
    const onXLink = (e: Event) => {
      // detail is the new handle or null; a disconnect hides the wallet at once
      const handle = (e as CustomEvent).detail;
      if (handle) refresh();
      else {
        setConnected(false);
        setOpen(false);
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(COIN_BALANCE_EVENT, onCoins);
    window.addEventListener(X_LINK_EVENT, onXLink);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(COIN_BALANCE_EVENT, onCoins);
      window.removeEventListener(X_LINK_EVENT, onXLink);
    };
  }, [refresh]);

  if (!connected) return null;

  const buy = async (payload: { packId: string } | { amountCents: number }) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const endpoint =
        method === "crypto" ? "/api/coins/crypto" : "/api/coins/checkout";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.assign(data.url); // hosted checkout (Stripe / NOWPayments)
        return;
      }
      setErr(data.error ?? "Couldn't start checkout — try again.");
    } catch {
      setErr("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  // Validate the custom amount ($5–$500) client-side for a friendly error, then
  // hand the server the authoritative cents.
  const buyCustom = () => {
    const usd = Number(customUsd);
    if (!Number.isFinite(usd) || usd < 5) {
      setErr("enter an amount of $5 or more");
      return;
    }
    if (usd > 500) {
      setErr("$500 max per top-up");
      return;
    }
    buy({ amountCents: Math.round(usd * 100) });
  };

  return (
    <>
      <button
        onClick={() => {
          setErr("");
          setOpen(true);
        }}
        title="Your coins — buy more"
        aria-label={`${balance ?? 0} coins — buy more`}
        className="flex items-center gap-1.5 normal-case text-gold hover:text-orange-deep cursor-pointer"
      >
        <CoinIcon size={18} className="drop-shadow-[0_1px_0_rgba(0,0,0,0.35)]" />
        <span>{balance ?? 0}</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="pixel-panel p-6 w-72 text-center normal-case"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-pixel text-[10px] uppercase text-orange-deep">
              buy coins
            </p>
            <p className="font-sans text-xl text-muted mt-2 inline-flex flex-wrap items-center justify-center gap-x-1.5 leading-snug">
              spend on skins, revives &amp; more
              {balance !== null ? (
                <>
                  {" · you have "}
                  {balance}
                  <CoinIcon size={15} className="inline-block align-[-3px]" />
                </>
              ) : null}
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {COIN_PACKS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => buy({ packId: p.id })}
                  disabled={busy}
                  className="pixel-btn bg-orange text-white text-[10px] py-2.5 flex flex-col items-center gap-1"
                >
                  <span>
                    {p.label} — ${(p.priceCents / 100).toFixed(2)}
                  </span>
                  <span className="font-sans normal-case text-base text-white/85 leading-none">
                    {p.blurb}
                  </span>
                </button>
              ))}
              {/* Custom top-up: any amount $5–$500, priced at 50 coins per $1 */}
              <div className="flex items-stretch gap-2 font-sans text-xl">
                <div className="flex flex-1 items-center gap-1 border-[3px] border-ink bg-white/40 px-2.5">
                  <span className="text-muted">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={5}
                    max={500}
                    step={1}
                    value={customUsd}
                    onChange={(e) => setCustomUsd(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && buyCustom()}
                    disabled={busy}
                    placeholder="custom amount"
                    aria-label="custom amount in dollars"
                    className="w-full bg-transparent outline-none placeholder:text-muted/70"
                  />
                </div>
                <button
                  onClick={buyCustom}
                  disabled={busy}
                  className="pixel-btn bg-orange text-white text-[10px] px-3"
                >
                  buy
                </button>
              </div>
              <p className="font-sans text-lg text-muted -mt-1">
                min $5 · max $500 · 50 coins per $1
              </p>
              <div className="flex items-center justify-center gap-1.5 font-sans text-xl">
                <span className="text-muted normal-case">pay with</span>
                <button
                  onClick={() => setMethod("card")}
                  disabled={busy}
                  aria-pressed={method === "card"}
                  className={`normal-case underline-offset-2 ${
                    method === "card"
                      ? "text-orange-deep underline"
                      : "text-muted hover:text-orange-deep"
                  }`}
                >
                  card
                </button>
                <span className="text-muted">·</span>
                <button
                  onClick={() => setMethod("crypto")}
                  disabled={busy}
                  aria-pressed={method === "crypto"}
                  className={`normal-case underline-offset-2 ${
                    method === "crypto"
                      ? "text-orange-deep underline"
                      : "text-muted hover:text-orange-deep"
                  }`}
                >
                  crypto
                </button>
              </div>
              {err && <p className="font-sans text-lg text-red">{err}</p>}
              <button
                onClick={() => setOpen(false)}
                className="font-sans text-2xl underline hover:text-orange-deep"
              >
                {busy ? "opening checkout…" : "maybe later"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
