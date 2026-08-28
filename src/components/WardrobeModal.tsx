"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { composeBird, cosmeticForDay } from "@/game/cosmetics";
import {
  DEFAULT_FIT,
  NONE,
  PIECES,
  SLOTS,
  canWear,
  composeFit,
  fitLabel,
  isFree,
  loadFit,
  loadStats,
  pieceCost,
  piecesForSlot,
  randomFit,
  saveFit,
  type Fit,
  type Piece,
  type Slot,
} from "@/game/wardrobe";
import { COIN_BALANCE_EVENT } from "@/lib/coins";
import { utcDay } from "@/lib/day";
import CoinIcon from "./CoinIcon";
import { BirdSpriteSvg } from "./PixelBird";

const PAID_COUNT = PIECES.filter((p) => !isFree(p)).length;

// The dressing room. The free starter basics wear (and persist) immediately —
// there's no save step; "today's fit" hands the bird back to the daily
// rotation. Most pieces are a paid unlock: tapping a locked one buys it with
// coins (the wallet belongs to a connected X account) and then
// wears it. Ownership + balance load from /api/wardrobe/owned; the worn fit
// itself stays in localStorage.
export default function WardrobeModal({ onClose }: { onClose: () => void }) {
  const [fit, setFit] = useState<Fit | null>(() => loadFit());
  const [slot, setSlot] = useState<Slot>("hat");
  const [best] = useState(() => loadStats().best);
  const [frame, setFrame] = useState<0 | 1>(0);

  const [connected, setConnected] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [owned, setOwned] = useState<ReadonlySet<string>>(() => new Set());
  const [buying, setBuying] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    fetch("/api/wardrobe/owned")
      .then((r) => r.json())
      .then((d) => {
        setConnected(!!d?.connected);
        if (typeof d?.balance === "number") setBalance(d.balance);
        if (Array.isArray(d?.owned)) setOwned(new Set<string>(d.owned));
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
    window.addEventListener("focus", onFocus);
    window.addEventListener(COIN_BALANCE_EVENT, onCoins);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(COIN_BALANCE_EVENT, onCoins);
    };
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f === 0 ? 1 : 0)), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const day = utcDay();
  const base = fit ?? DEFAULT_FIT;
  const preview = useMemo(
    () =>
      fit ? composeFit(fit, frame === 1) : composeBird(cosmeticForDay(day), frame === 1),
    [fit, frame, day]
  );

  const wear = (pieceId: string) => {
    const next = { ...base, [slot]: pieceId };
    setFit(next);
    saveFit(next);
  };

  // Buy a paid piece with coins, then wear it. Needs a connected X account (the
  // wallet); the server re-prices from the catalog, so nothing here is trusted.
  const buy = async (piece: Piece) => {
    if (buying) return;
    if (!connected) {
      setNotice("connect 𝕏 below to buy pieces");
      return;
    }
    setBuying(piece.id);
    setNotice("");
    try {
      const res = await fetch("/api/wardrobe/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pieceId: piece.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setOwned((prev) => new Set(prev).add(piece.id));
        if (typeof data.balance === "number") {
          setBalance(data.balance);
          // let the header wallet update too
          window.dispatchEvent(
            new CustomEvent(COIN_BALANCE_EVENT, { detail: data.balance })
          );
        }
        wear(piece.id); // equip the freshly bought piece
      } else if (res.status === 402) {
        if (typeof data.balance === "number") setBalance(data.balance);
        setNotice(`not enough coins — ${piece.label} costs ${pieceCost(piece)}`);
      } else if (data?.needsX) {
        setConnected(false);
        setNotice("connect 𝕏 below to buy pieces");
      } else {
        setNotice(data?.error ?? "couldn't buy — try again");
      }
    } catch {
      setNotice("network error — try again");
    } finally {
      setBuying(null);
    }
  };

  const tap = (piece: Piece) => {
    if (canWear(piece, owned)) wear(piece.id);
    else buy(piece);
  };

  const surprise = () => {
    const next = randomFit(owned);
    setFit(next);
    saveFit(next);
  };

  const wearDaily = () => {
    setFit(null);
    saveFit(null);
  };

  const ownedPaid = PIECES.filter((p) => !isFree(p) && owned.has(p.id)).length;

  return (
    <div
      className="fixed inset-0 z-50 flex bg-scrim/60 overscroll-contain sm:items-center sm:justify-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-paper flex flex-col w-full h-[100dvh] overflow-hidden sm:h-auto sm:max-h-[90vh] sm:max-w-[420px] sm:border-4 sm:border-ink sm:shadow-[6px_6px_0_rgba(0,0,0,0.35)]">
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-sand border-b-4 border-ink pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="font-pixel text-[11px]">wardrobe</p>
            <p className="text-base text-muted mt-1.5">
              dress your bird — it flies like this
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {connected && (
              <span
                className="flex items-center gap-1.5 text-gold"
                title="your coins"
              >
                <CoinIcon size={16} className="drop-shadow-[0_1px_0_rgba(0,0,0,0.35)]" />
                <span className="font-pixel text-[10px]">{balance ?? 0}</span>
              </span>
            )}
            <button
              onClick={onClose}
              className="font-pixel text-sm px-3 py-2 -mr-2 hover:text-orange-deep"
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* preview */}
          <div className="px-4 pt-5 pb-4 text-center border-b-[3px] border-dashed border-ink/30">
            <div className="h-20 flex items-center justify-center">
              <BirdSpriteSvg bird={preview} className="w-24 h-[4.5rem] animate-float" />
            </div>
            <p className="font-pixel text-[8px] uppercase text-muted mt-2">
              {fit ? `your fit: ${fitLabel(fit)}` : `today's fit: ${cosmeticForDay(day).label}`}
            </p>
            <p className="text-base text-muted mt-1.5">
              best ever {best} ·{" "}
              {connected
                ? `${ownedPaid}/${PAID_COUNT} pieces owned`
                : "starter basics free · buy more with coins"}
            </p>
          </div>

          {/* slot tabs */}
          <div className="flex border-b-[3px] border-ink">
            {SLOTS.map(({ slot: s, label }) => (
              <button
                key={s}
                onClick={() => setSlot(s)}
                className={`flex-1 font-pixel text-[8px] uppercase py-2.5 ${
                  s === slot
                    ? "bg-orange text-white"
                    : "bg-paper text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* piece grid */}
          <div className="grid grid-cols-3 gap-3 p-4">
            {slot !== "skin" && (
              <PieceTile
                label={NONE}
                selected={fit !== null && base[slot] === NONE}
                cost={0}
                bird={composeFit({ ...base, [slot]: NONE })}
                onTap={() => wear(NONE)}
              />
            )}
            {piecesForSlot(slot).map((p) => {
              const wearable = canWear(p, owned);
              return (
                <PieceTile
                  key={p.id}
                  label={p.label}
                  selected={fit !== null && base[slot] === p.id}
                  cost={wearable ? 0 : pieceCost(p)}
                  buying={buying === p.id}
                  bird={composeFit({ ...base, [slot]: p.id })}
                  onTap={() => tap(p)}
                />
              );
            })}
          </div>
        </div>

        <div className="shrink-0 border-t-4 border-ink bg-sand pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {(notice || !connected) && (
            <div className="px-4 pt-2.5 text-center">
              {notice && (
                <p className="font-sans text-lg text-red">{notice}</p>
              )}
              {!connected && (
                <a
                  href="/api/x/connect"
                  className="inline-block mt-1 font-sans text-lg underline text-orange-deep hover:text-orange"
                  title="Connect X to buy wardrobe pieces with coins"
                >
                  connect 𝕏 to buy pieces
                </a>
              )}
            </div>
          )}
          <div className="flex gap-3 px-4 py-3">
            <button
              onClick={surprise}
              className="pixel-btn bg-orange text-white text-[9px] px-4 py-2.5 flex-1"
            >
              surprise me
            </button>
            <button
              onClick={wearDaily}
              disabled={fit === null}
              className="pixel-btn bg-paper text-[9px] px-4 py-2.5 flex-1 disabled:opacity-50"
            >
              today&apos;s fit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PieceTile({
  label,
  selected,
  cost,
  buying,
  bird,
  onTap,
}: {
  label: string;
  selected: boolean;
  /** coins to unlock; 0 when it's free or already owned (i.e. wearable) */
  cost: number;
  buying?: boolean;
  bird: ReturnType<typeof composeFit>;
  onTap: () => void;
}) {
  const locked = cost > 0;
  return (
    <button
      onClick={onTap}
      disabled={buying}
      title={locked ? `${label} — buy for ${cost} coins` : label}
      className={`relative flex flex-col items-center gap-2 border-[3px] p-2.5 pt-3.5 bg-paper ${
        selected
          ? "border-orange-deep shadow-[3px_3px_0_var(--color-orange-deep)]"
          : "border-ink"
      } ${buying ? "opacity-60" : "hover:border-orange-deep"}`}
    >
      <span
        className={`h-9 flex items-center justify-center ${
          locked ? "opacity-55" : ""
        }`}
      >
        <BirdSpriteSvg bird={bird} className="w-12 h-9" />
      </span>
      {locked ? (
        <span className="flex items-center gap-1 font-pixel text-[7px] uppercase leading-relaxed text-orange-deep">
          {buying ? (
            "…"
          ) : (
            <>
              <CoinIcon size={9} />
              {cost}
            </>
          )}
        </span>
      ) : (
        <span className="font-pixel text-[7px] uppercase leading-relaxed">
          {label}
        </span>
      )}
    </button>
  );
}
