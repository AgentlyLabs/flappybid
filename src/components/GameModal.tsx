"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  WIDTH,
  HEIGHT,
  TICK_HZ,
  SIM_VERSION,
  PIPE_WIDTH,
} from "@/game/constants";
import {
  createSim,
  step,
  revive,
  pipeX,
  laserState,
  type SimState,
} from "@/game/sim";
import { REVIVE_COST, REVIVES_PER_RUN } from "@/lib/economy";
import { COIN_PACKS, COIN_BALANCE_EVENT } from "@/lib/coins";
import { LOGO_PRICE_CENTS } from "@/lib/logo";
import CoinIcon from "./CoinIcon";
import { MAPS, MAP_LIST, isMapId, mapForDay, type MapDef, type MapId } from "@/game/maps";
import { drawFrame } from "@/game/render";
import { recordRun } from "@/game/wardrobe";
import {
  sfx,
  isMuted,
  setMuted,
  isMusicMuted,
  setMusicMuted,
  startMusic,
  stopMusic,
} from "@/game/sound";
import { CHECKPOINT_EVERY_FRAMES, inputsHash } from "@/game/checkpoint";
import { utcDay } from "@/lib/day";
import { ensureHuman } from "@/lib/human-client";

export interface PlayableProduct {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

interface Props {
  product: PlayableProduct;
  onClose: () => void;
  onScored: () => void;
  /** closes this modal and opens the flappy-logo bid flow */
  onBuyLogo?: () => void;
}

type Phase =
  | "starting"
  | "ready"
  | "playing"
  | "revive"
  | "submitting"
  | "result"
  | "error";

interface RunResult {
  /** board score: raw score doubled when a daily boost (PH vote / X share) was active */
  score: number;
  rawScore?: number;
  boost?: number;
  best: number;
  isNewBest: boolean;
  rank: number;
}

const STEP_SEC = 1 / TICK_HZ;
// how long the revive offer stays up before the run submits as-is
const REVIVE_SECS = 6;
// the picker re-issues a run on every map switch (each course needs its own
// server seed). Coalesce a burst of switches into a single seed fetch so
// rapid browsing — natural when tapping ‹ › on a phone — doesn't fire a
// /api/run/start per tap and trip its 750ms spacing limit (a 429 the old
// code turned into the error panel, which reads as the game crashing).
// Kept above that 750ms gap on purpose.
const SWITCH_DEBOUNCE_MS = 800;

export default function GameModal({
  product,
  onClose,
  onScored,
  onBuyLogo,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimState | null>(null);
  const runRef = useRef<{ runId: string; seed: number } | null>(null);
  // live-checkpoint state: rolling server nonce, next frame due, and
  // whether a beat is already in flight (never more than one)
  const cpRef = useRef<{
    nonce: string;
    nextFrame: number;
    busy: boolean;
  } | null>(null);
  const flapsRef = useRef<number[]>([]);
  const shotsRef = useRef<number[]>([]);
  // revive bookkeeping: the frames the run came back from (sent at submit),
  // how many revives it's used so far (capped at REVIVES_PER_RUN), and the
  // frame of the death currently being offered a revive
  const reviveFramesRef = useRef<number[]>([]);
  const revivesUsedRef = useRef(0);
  const deathFrameRef = useRef(0);
  const pendingFlapRef = useRef(false);
  const pendingShootRef = useRef(false);
  const laserFiringRef = useRef(false);
  const phaseRef = useRef<Phase>("starting");
  const rafRef = useRef(0);
  const mapRef = useRef<MapDef | null>(null);
  // daily boost (PH vote / X share), as of run start — display only (gold
  // counter + pops); the server re-checks it at submit and the sim never
  // sees it
  const boostRef = useRef(1);
  const bumpRef = useRef<{ at: number; gain: number } | null>(null);
  // pending debounced map switch, and the map currently selected in the
  // picker — the selection leads the loaded run while a switch is settling
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selMapIdRef = useRef<MapId | null>(null);

  const [phase, setPhaseState] = useState<Phase>("starting");
  const [result, setResult] = useState<RunResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [banned, setBanned] = useState(false);
  // coin wallet: null until the first read lands, then kept in sync from the
  // revive response and the wallet read — no polling. Coins are bought, not
  // earned, so a scored run never changes this.
  const [balance, setBalance] = useState<number | null>(null);
  // whether an X account is connected — the wallet belongs to the @handle, so
  // reviving and buying coins both require it
  const [xConnected, setXConnected] = useState(false);
  // set the local balance AND tell the rest of the page (the header wallet)
  // so every coin display agrees after a spend
  const applyBalance = useCallback((n: number) => {
    setBalance(n);
    window.dispatchEvent(new CustomEvent(COIN_BALANCE_EVENT, { detail: n }));
  }, []);
  // seconds left on the revive offer; drives the countdown on the button
  const [reviveSecs, setReviveSecs] = useState(REVIVE_SECS);
  // the score frozen at the death being offered a revive (captured on death so
  // the offer panel doesn't read the sim ref during render)
  const [reviveScore, setReviveScore] = useState(0);
  // set while the revive charge is in flight, so the button can't double-fire
  const [reviving, setReviving] = useState(false);
  // coin-pack picker: shown on top of any phase; buyBusy gates the redirect,
  // buyError surfaces a failed checkout start without leaving the picker
  const [showPacks, setShowPacks] = useState(false);
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState("");
  // pay rail for the picker: "card" → Stripe, "crypto" → NOWPayments. Both
  // endpoints take { packId } or { amountCents } and return a hosted { url }.
  const [buyMethod, setBuyMethod] = useState<"card" | "crypto">("card");
  // custom top-up amount in whole dollars (string so the field can be empty)
  const [customUsd, setCustomUsd] = useState("");
  const [mapDef, setMapDef] = useState<MapDef | null>(null);
  // the modal only mounts client-side (opened by a click), so the stored
  // mute preferences can seed state directly — no hydration to mismatch
  const [soundOff, setSoundOff] = useState(
    () => typeof window !== "undefined" && isMuted()
  );
  const [musicOff, setMusicOff] = useState(
    () => typeof window !== "undefined" && isMusicMuted()
  );
  // X share boost claimed-state, mirrored from PHBoostButton: localStorage
  // only remembers the claim so the banner can show it — the server tracks
  // the real grant by ip hash (/api/boost/share)
  const [xShared, setXShared] = useState(
    () => typeof window !== "undefined" && xSharedToday()
  );

  // self-heal, same story as PHBoostButton: a claim that failed server-side
  // (or landed under a different network's ip hash) converges by re-firing
  // the idempotent grant whenever the modal opens with a claimed state
  useEffect(() => {
    if (xSharedToday()) {
      fetch("/api/boost/share", { method: "POST", keepalive: true }).catch(
        () => {}
      );
    }
  }, []);

  // read the coin balance once on open; after that it only changes on a revive
  // spend (coins are bought, not earned), so no polling
  useEffect(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => {
        setXConnected(!!d?.connected);
        if (typeof d?.balance === "number") applyBalance(d.balance);
      })
      .catch(() => {});
  }, [applyBalance]);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const startRun = useCallback(
    async (pick?: MapId) => {
      // we're issuing now — cancel any debounced switch still waiting to fire
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
      setPhase("starting");
      setResult(null);
      // sticky within the modal ("fly again" keeps the map); classic meadow
      // is the first-open default for every user
      const mapId = pick ?? mapRef.current?.id ?? "classic";
      try {
        const start = () =>
          fetch("/api/run/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId: product.id, mapId }),
          });
        let res = await start();
        let data = await res.json();
        // Turnstile day-pass missing or expired: solve the (usually
        // invisible) challenge once, then ask for the seed again
        if (!res.ok && data.humanCheck && (await ensureHuman())) {
          res = await start();
          data = await res.json();
        }
        // run/start enforces a minimum spacing between seeds (anti seed-farm).
        // A legit burst — mashing "fly again", or a switch racing the last
        // start — can land inside that window; wait out the gap and retry once
        // rather than dropping the player into the error panel.
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 800));
          res = await start();
          data = await res.json();
        }
        if (!res.ok) {
          if (data.banned) setBanned(true);
          setErrorMsg(data.error ?? "Could not start a run.");
          setPhase("error");
          return;
        }
        // sim the map the server actually froze onto the run, not the ask
        const serverMapId: unknown = data.map;
        const map = isMapId(serverMapId) ? MAPS[serverMapId] : MAPS.classic;
        mapRef.current = map;
        selMapIdRef.current = map.id;
        setMapDef(map);
        runRef.current = { runId: data.runId, seed: data.seed };
        // server hands out a nonce iff checkpointing is on (see
        // src/game/checkpoint.ts) — without one we never stream beats
        cpRef.current =
          typeof data.cp === "string"
            ? { nonce: data.cp, nextFrame: CHECKPOINT_EVERY_FRAMES, busy: false }
            : null;
        boostRef.current = Number(data.boost) > 1 ? Number(data.boost) : 1;
        bumpRef.current = null;
        simRef.current = createSim(data.seed, map);
        flapsRef.current = [];
        shotsRef.current = [];
        reviveFramesRef.current = [];
        revivesUsedRef.current = 0;
        pendingFlapRef.current = false;
        pendingShootRef.current = false;
        laserFiringRef.current = false;
        setPhase("ready");
      } catch {
        setErrorMsg("Network error — try again.");
        setPhase("error");
      }
    },
    [product.id, setPhase]
  );

  // ready-screen picker: each switch starts a fresh run on the new map, so
  // the seed is always server-issued for exactly the course being flown
  const cycleMap = useCallback(
    (dir: number) => {
      if (phaseRef.current !== "ready") return;
      // browse off the pending selection, not the loaded run, so several taps
      // in a row keep advancing while the seed fetch is still debounced
      const baseId = selMapIdRef.current ?? mapRef.current?.id;
      const cur = MAP_LIST.findIndex((m) => m.id === baseId);
      const next = MAP_LIST[(cur + dir + MAP_LIST.length) % MAP_LIST.length];
      selMapIdRef.current = next.id;
      setMapDef(next); // instant label/blurb/combat-hint preview
      // coalesce a burst of switches into one seed fetch when the player settles
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
      switchTimerRef.current = setTimeout(() => {
        switchTimerRef.current = null;
        startRun(next.id);
      }, SWITCH_DEBOUNCE_MS);
    },
    [startRun]
  );

  const submitRun = useCallback(async () => {
    const sim = simRef.current;
    const run = runRef.current;
    if (!sim || !run) return;
    setPhase("submitting");
    try {
      const res = await fetch("/api/run/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run.runId,
          flapFrames: flapsRef.current,
          ...(shotsRef.current.length
            ? { shootFrames: shotsRef.current }
            : {}),
          ...(reviveFramesRef.current.length
            ? { reviveFrames: reviveFramesRef.current }
            : {}),
          claimedScore: sim.score,
          simVersion: SIM_VERSION,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.banned) setBanned(true);
        setErrorMsg(data.error ?? "Run rejected.");
        setPhase("error");
        return;
      }
      setResult(data);
      setPhase("result");
      if (data.isNewBest && data.score > 0) sfx.best();
      recordRun(sim.score); // local stats — drives wardrobe unlocks
      onScored();
    } catch {
      setErrorMsg("Network error — the run was lost.");
      setPhase("error");
    }
  }, [onScored, setPhase]);

  // The bird just died (music + die sfx already fired). Offer a revive if the
  // run hasn't used its allotment; otherwise submit the run as it stands.
  const handleDeath = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (revivesUsedRef.current < REVIVES_PER_RUN) {
      deathFrameRef.current = sim.frame;
      setReviveScore(sim.score);
      setReviveSecs(REVIVE_SECS);
      setReviving(false);
      setPhase("revive");
    } else {
      submitRun();
    }
  }, [submitRun, setPhase]);

  // Player took the revive: charge coins server-side FIRST (the server debits
  // atomically and caps revives per run — the client never mints a free one),
  // then bring the bird back and fly on. The death frame is recorded now so
  // submit can send it; the server's replay must reproduce a death there.
  const confirmRevive = useCallback(async () => {
    const sim = simRef.current;
    const run = runRef.current;
    if (!sim || !run || reviving) return;
    setReviving(true);
    try {
      const res = await fetch("/api/run/revive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.runId }),
      });
      const data = await res.json();
      if (typeof data.balance === "number") applyBalance(data.balance);
      if (!res.ok) {
        // out of coins / revives / a hiccup — take the run as it stands
        submitRun();
        return;
      }
      reviveFramesRef.current.push(deathFrameRef.current);
      revivesUsedRef.current += 1;
      revive(sim);
      sfx.revive();
      // resume the run's music from where death cut it off
      startMusic(mapRef.current?.id);
      setReviving(false);
      setPhase("playing");
    } catch {
      submitRun();
    }
  }, [reviving, submitRun, setPhase, applyBalance]);

  // Buy a coin pack: the Stripe redirect leaves the page, so if a run is still
  // in flight (the revive offer is up) bank it FIRST — its score and earned
  // coins would otherwise be lost to the navigation. The coins land on the
  // wallet via the webhook; on return the next /api/wallet read reflects them.
  const startCheckout = useCallback(
    async (payload: { packId: string } | { amountCents: number }) => {
      if (buyBusy) return;
      setBuyBusy(true);
      setBuyError("");
      if (phaseRef.current === "revive") await submitRun();
      try {
        const endpoint =
          buyMethod === "crypto" ? "/api/coins/crypto" : "/api/coins/checkout";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok && data.url) {
          window.location.href = data.url; // hosted checkout (Stripe / NOWPayments)
          return;
        }
        setBuyError(data.error ?? "Couldn't start checkout — try again.");
      } catch {
        setBuyError("Network error — try again.");
      } finally {
        setBuyBusy(false);
      }
    },
    [buyBusy, submitRun, buyMethod]
  );

  // Validate the custom amount ($5–$500) client-side, then let the server price
  // the authoritative cents.
  const startCustomCheckout = useCallback(() => {
    const usd = Number(customUsd);
    if (!Number.isFinite(usd) || usd < 5) {
      setBuyError("enter an amount of $5 or more");
      return;
    }
    if (usd > 500) {
      setBuyError("$500 max per top-up");
      return;
    }
    startCheckout({ amountCents: Math.round(usd * 100) });
  }, [customUsd, startCheckout]);

  // the revive offer is a race against the clock: let it run out and the run
  // submits as-is, so a walked-away tab still posts its score
  useEffect(() => {
    if (phase !== "revive") return;
    // reviveSecs was seeded in handleDeath; here we only run the clock down
    let secs = REVIVE_SECS;
    const id = setInterval(() => {
      secs -= 1;
      setReviveSecs(secs);
      if (secs <= 0) {
        clearInterval(id);
        submitRun();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase, submitRun]);

  // Live checkpoint beat: every ~10s of sim, commit the input streams sent
  // so far (frame + prefix hash + the server's nonce). Fire-and-forget with
  // one in flight at a time; a dropped beat or lost response just resyncs
  // on the next one — the server's coverage floor tolerates a few misses.
  const pulse = useCallback((frame: number) => {
    const cp = cpRef.current;
    const run = runRef.current;
    if (!cp || !run || cp.busy || frame < cp.nextFrame) return;
    cp.busy = true;
    cp.nextFrame = frame + CHECKPOINT_EVERY_FRAMES;
    const hash = inputsHash(flapsRef.current, shotsRef.current, frame);
    fetch("/api/run/checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.runId, frame, hash, nonce: cp.nonce }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.nonce === "string") cp.nonce = d.nonce;
      })
      .catch(() => {})
      .finally(() => {
        cp.busy = false;
      });
  }, []);

  // shooting never starts the run (a stray trigger pull on the ready screen
  // shouldn't launch the bird) and only combat maps have a gun
  const shoot = useCallback(() => {
    if (phaseRef.current === "playing" && mapRef.current?.combat) {
      pendingShootRef.current = true;
    }
  }, []);

  // input
  useEffect(() => {
    const flap = () => {
      if (phaseRef.current === "ready") {
        // a map switch is still settling: issue its run now rather than launch
        // on the previous map's sim. The seeded "ready" lands a beat later and
        // the next tap flies it.
        if (switchTimerRef.current && selMapIdRef.current) {
          startRun(selMapIdRef.current);
          return;
        }
        pendingFlapRef.current = true;
        setPhase("playing");
        // first flap of the run is a user gesture, which is what unlocks
        // audio — so this is the earliest the music can start
        startMusic(mapRef.current?.id);
        sfx.flap();
      } else if (phaseRef.current === "playing") {
        pendingFlapRef.current = true;
        sfx.flap();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        // no OS auto-repeat: one keypress = one flap, like a tap. Holding a
        // key would otherwise emit metronome-perfect flaps — both an easy
        // hover exploit and a false positive for the bot detector.
        if (!e.repeat) flap();
      }
      if (e.code === "KeyX") {
        e.preventDefault();
        if (!e.repeat) shoot();
      }
      // browse maps on the ready screen (cycleMap no-ops elsewhere)
      if (e.code === "ArrowLeft") cycleMap(-1);
      if (e.code === "ArrowRight") cycleMap(1);
      if (e.code === "Escape") onClose();
    };
    const canvas = canvasRef.current;
    const onPointer = (e: PointerEvent) => {
      e.preventDefault();
      flap();
    };
    window.addEventListener("keydown", onKey);
    canvas?.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      canvas?.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose, setPhase, cycleMap, shoot, startRun]);

  // sim + render loop
  useEffect(() => {
    let last = performance.now();
    let acc = 0;
    let readyTime = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const sim = simRef.current;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;

      if (phaseRef.current === "playing" && sim && !sim.dead) {
        acc += dt;
        const pipesBefore = sim.score - sim.bonus;
        const bonusBefore = sim.bonus;
        while (acc >= STEP_SEC && !sim.dead) {
          acc -= STEP_SEC;
          const doFlap = pendingFlapRef.current;
          pendingFlapRef.current = false;
          const doShoot = pendingShootRef.current;
          pendingShootRef.current = false;
          if (doFlap) flapsRef.current.push(sim.frame);
          if (doShoot) {
            shotsRef.current.push(sim.frame);
            // sound only when the weapon actually fires, not on a cooldown
            // trigger pull — the sim is the authority on that
            if (sim.cooldown === 0) {
              if (sim.map.combat?.weapon === "beam") sfx.beam();
              else sfx.shoot();
            }
          }
          step(sim, doFlap, doShoot);
        }
        if (sim.dead) {
          stopMusic();
          sfx.die();
          handleDeath();
        } else {
          pulse(sim.frame);
          const gained = sim.score - (pipesBefore + bonusBefore);
          if (gained > 0) bumpRef.current = { at: now, gain: gained };
          if (sim.score - sim.bonus > pipesBefore) sfx.score(sim.score);
          if (sim.bonus > bonusBefore) sfx.pop();
          // one zap per volley: fires when any on-screen laser gate opens up
          if (sim.map.combat) {
            let firing = false;
            for (const pipe of sim.pipes) {
              const px = pipeX(sim, pipe);
              if (px > WIDTH) break;
              if (px < -PIPE_WIDTH) continue;
              if (laserState(sim, pipe) === "fire") {
                firing = true;
                break;
              }
            }
            if (firing && !laserFiringRef.current) sfx.zap();
            laserFiringRef.current = firing;
          }
        }
      } else {
        acc = 0;
        readyTime += dt;
      }
      if (sim) {
        const p = phaseRef.current;
        drawFrame(ctx, sim, {
          now,
          showScore: p === "playing" || p === "submitting" || p === "revive",
          bobTime: p === "ready" || p === "starting" ? readyTime : undefined,
          boost: boostRef.current,
          scoreBumpAt: bumpRef.current?.at,
          scoreBumpGain: bumpRef.current?.gain,
        });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [handleDeath, pulse]);

  useEffect(() => {
    startRun();
  }, [startRun]);

  // closing the modal mid-flight must not leave the loop playing, nor a
  // debounced map switch firing a run after the modal is gone
  useEffect(
    () => () => {
      stopMusic();
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    },
    []
  );

  return (
    // full-screen takeover on phones; centered pixel card from sm up
    <div className="fixed inset-0 z-50 flex bg-scrim/60 overscroll-contain sm:items-center sm:justify-center sm:p-4">
      <div className="bg-paper flex flex-col w-full h-[100dvh] overflow-hidden sm:h-auto sm:max-w-[420px] sm:border-4 sm:border-ink sm:shadow-[6px_6px_0_rgba(0,0,0,0.35)]">
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-sand border-b-4 border-ink pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-base leading-none text-muted">flying for</p>
            <p className="font-pixel text-[11px] truncate mt-1.5">
              {product.name}
            </p>
          </div>
          <div className="flex items-center">
            {xConnected && balance !== null && (
              <span
                className="font-pixel text-[9px] text-gold text-outline mr-1.5 whitespace-nowrap inline-flex items-center gap-1"
                title="coins — buy them, spend on skins, revives & more"
              >
                {balance} <CoinIcon size={12} className="inline-block align-[-1px]" />
              </span>
            )}
            <button
              onClick={() => {
                const next = !musicOff;
                setMusicMuted(next);
                setMusicOff(next);
                if (next) stopMusic();
                // unmuting mid-flight brings the music straight back
                else if (phaseRef.current === "playing")
                  startMusic(mapRef.current?.id);
              }}
              className={`text-xl px-2 py-2 hover:opacity-70 ${
                musicOff ? "opacity-40 grayscale" : ""
              }`}
              aria-label={musicOff ? "Unmute music" : "Mute music"}
            >
              🎵
            </button>
            <button
              onClick={() => {
                const next = !soundOff;
                setMuted(next);
                setSoundOff(next);
              }}
              className="text-xl px-2 py-2 hover:opacity-70"
              aria-label={soundOff ? "Unmute sound effects" : "Mute sound effects"}
            >
              {soundOff ? "🔇" : "🔊"}
            </button>
            <button
              onClick={onClose}
              className="font-pixel text-sm px-3 py-2 -mr-2 hover:text-orange-deep"
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>

        <div className="relative flex-1 min-h-0 bg-scrim flex items-center justify-center sm:flex-none sm:bg-paper sm:block">
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            className="block touch-none select-none cursor-pointer max-w-full max-h-full sm:w-full sm:h-auto sm:max-h-none"
          />

          {mapDef?.combat && phase === "playing" && (
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                shoot();
              }}
              className="absolute bottom-4 right-4 pixel-btn bg-red text-white font-pixel text-[10px] px-4 py-3 touch-none select-none"
              aria-label="Fire"
            >
              {mapDef.combat?.weapon === "beam" ? "BEAM" : "FIRE"}
            </button>
          )}

          {phase === "starting" && (
            <Overlay>
              <p className="font-pixel text-[10px] text-white text-outline">
                getting a seed…
              </p>
            </Overlay>
          )}

          {phase === "ready" && (
            <Overlay>
              <div className="text-center">
                <p className="font-pixel text-xl text-gold text-outline mb-3">
                  TAP TO FLAP
                </p>
                <p className="text-xl text-white text-outline">
                  space / click / tap to flap
                </p>
                {mapDef?.combat && (
                  <p className="text-xl text-white text-outline mt-1">
                    {mapDef.combat.weapon === "beam"
                      ? "X / BEAM button fires the mega laser"
                      : "X / FIRE button to shoot"}
                  </p>
                )}
                {mapDef && (
                  <div className="mt-6">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => cycleMap(-1)}
                        className="pixel-btn bg-paper font-pixel text-[10px] px-3 py-2"
                        aria-label="Previous map"
                      >
                        ‹
                      </button>
                      <p className="font-pixel text-[10px] uppercase text-white text-outline w-44">
                        {mapDef.label}
                        {mapDef.id === mapForDay(utcDay()).id && " ★"}
                      </p>
                      <button
                        onClick={() => cycleMap(1)}
                        className="pixel-btn bg-paper font-pixel text-[10px] px-3 py-2"
                        aria-label="Next map"
                      >
                        ›
                      </button>
                    </div>
                    <p className="text-base text-white text-outline mt-2">
                      {mapDef.blurb}
                    </p>
                    <p className="text-base text-white/80 text-outline mt-1">
                      ← → keys switch maps
                    </p>
                  </div>
                )}
              </div>
            </Overlay>
          )}

          {phase === "submitting" && (
            <Overlay>
              <p className="font-pixel text-[10px] text-white text-outline">
                verifying run…
              </p>
            </Overlay>
          )}

          {phase === "revive" && (
            <Overlay dim>
              <div className="pixel-panel p-6 w-72 text-center">
                <p className="font-pixel text-[10px] uppercase text-red">
                  you died
                </p>
                <p className="font-pixel text-4xl text-white text-outline my-3">
                  {reviveScore}
                </p>
                <p className="font-pixel text-[9px] uppercase text-orange-deep">
                  one more life?
                </p>
                <div className="mt-4 flex flex-col gap-3">
                  {!xConnected ? (
                    // no X account = no wallet; revives run on coins, which
                    // belong to the connected @handle
                    <a
                      href="/api/x/connect"
                      className="pixel-btn bg-orange text-white text-[10px] py-2.5 flex flex-col items-center gap-1"
                    >
                      <span>connect 𝕏 to revive</span>
                      <span className="font-sans normal-case text-base text-white/85 leading-none">
                        coins live on your X account
                      </span>
                    </a>
                  ) : (
                    <>
                      <button
                        onClick={confirmRevive}
                        disabled={reviving || (balance ?? 0) < REVIVE_COST}
                        className="pixel-btn bg-orange text-white text-[10px] py-2.5 flex flex-col items-center gap-1"
                      >
                        <span className="inline-flex items-center gap-1">
                          {reviving ? (
                            "reviving…"
                          ) : (
                            <>
                              revive — {REVIVE_COST}{" "}
                              <CoinIcon size={12} className="inline-block align-[-1px]" /> (
                              {reviveSecs})
                            </>
                          )}
                        </span>
                        <span className="font-sans normal-case text-base text-white/85 leading-none inline-flex items-center justify-center gap-1">
                          {(balance ?? 0) >= REVIVE_COST ? (
                            <>
                              you have {balance}{" "}
                              <CoinIcon size={11} className="inline-block align-[-1px]" />
                            </>
                          ) : (
                            <>
                              need {REVIVE_COST - (balance ?? 0)} more{" "}
                              <CoinIcon size={11} className="inline-block align-[-1px]" />
                            </>
                          )}
                        </span>
                      </button>
                      {(balance ?? 0) < REVIVE_COST && (
                        <button
                          onClick={() => {
                            setBuyError("");
                            setShowPacks(true);
                          }}
                          className="pixel-btn bg-paper text-[10px] py-2"
                        >
                          get more coins →
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => submitRun()}
                    className="text-lg underline hover:text-orange-deep"
                  >
                    no thanks
                  </button>
                </div>
              </div>
            </Overlay>
          )}

          {(phase === "result" || phase === "error") && (
            <Overlay dim>
              <div className="pixel-panel p-6 w-72 text-center">
                {phase === "result" && result ? (
                  <>
                    <p className="font-pixel text-[10px] uppercase text-orange-deep">
                      score
                    </p>
                    <p className="font-pixel text-4xl text-white text-outline my-3">
                      {result.score}
                    </p>
                    {(result.boost ?? 1) > 1 && result.score > 0 && (
                      <p className="font-pixel text-[8px] uppercase text-gold mb-2">
                        ▲ {result.rawScore} × {result.boost} daily boost
                      </p>
                    )}
                    {result.isNewBest && result.score > 0 ? (
                      <p className="font-pixel text-[9px] leading-relaxed text-orange-deep">
                        new best today — rank #{result.rank}
                      </p>
                    ) : (
                      <p className="text-lg">
                        best today {result.best} · rank #{result.rank}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-lg text-red">{errorMsg}</p>
                )}
                <div className="mt-5 flex flex-col gap-3">
                  {!banned && !errorMsg.startsWith("Champion —") && (
                    <button
                      onClick={() => startRun()}
                      className="pixel-btn bg-orange text-white text-[10px] py-2.5"
                    >
                      fly again
                    </button>
                  )}
                  {phase === "result" && (
                    <button
                      onClick={() => {
                        setBuyError("");
                        setShowPacks(true);
                      }}
                      className="pixel-btn bg-paper text-[10px] py-2 flex flex-col items-center gap-1"
                    >
                      <span className="inline-flex items-center gap-1">
                        buy coins <CoinIcon size={12} className="inline-block align-[-1px]" />
                      </span>
                      {balance !== null && (
                        <span className="font-sans normal-case text-base text-muted leading-none">
                          balance {balance} · revive costs {REVIVE_COST}
                        </span>
                      )}
                    </button>
                  )}
                  {phase === "result" && result && (
                    <button
                      onClick={() => {
                        shareOnX(product, result.best);
                        // the click IS the grant (see /api/boost/share) — the
                        // composer is already opening, the 2x lands behind it
                        fetch("/api/boost/share", {
                          method: "POST",
                          keepalive: true,
                        }).catch(() => {});
                        try {
                          localStorage.setItem("fb_x_boost", utcDay());
                        } catch {
                          // the server-side grant still applies; only the
                          // banner state is lost
                        }
                        setXShared(true);
                      }}
                      className="pixel-btn bg-paper text-[10px] py-2.5 flex flex-col items-center gap-1.5"
                    >
                      <span>flex it on 𝕏</span>
                      {xShared ? (
                        <span className="bg-gold text-ink border-2 border-ink px-1.5 py-0.5 text-[7px] uppercase">
                          2x active until the reset
                        </span>
                      ) : (
                        // same pulsing chip as the PH boost button
                        <span className="bg-gold text-ink border-2 border-ink px-1.5 py-0.5 text-[7px] uppercase animate-pulse">
                          share = 2x points today
                        </span>
                      )}
                    </button>
                  )}
                  {/* the only place the run screen mentions money. it sits
                      under both replay actions and stays paper rather than
                      orange, because the board is what you just played for
                      — this points at owning the flappy logo, never at a rank */}
                  {onBuyLogo && (
                    <button
                      onClick={onBuyLogo}
                      className="pixel-btn bg-paper py-2 flex flex-col items-center gap-1"
                    >
                      <span className="text-[9px]">
                        buy the flappy logo — ${(LOGO_PRICE_CENTS / 100).toLocaleString()}
                      </span>
                      <span className="font-sans normal-case text-base text-muted leading-none">
                        your brand, front and center
                      </span>
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="text-lg underline hover:text-orange-deep"
                  >
                    done
                  </button>
                </div>
              </div>
            </Overlay>
          )}

          {/* coin-pack picker — stacks on top of any phase. Coins land on the
              wallet via the Stripe webhook; the redirect leaves the page, so
              picking a pack banks an in-flight run first (see startCheckout) */}
          {showPacks && (
            <Overlay dim>
              <div className="pixel-panel p-6 w-72 text-center">
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
                      onClick={() => startCheckout({ packId: p.id })}
                      disabled={buyBusy}
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
                        onKeyDown={(e) => e.key === "Enter" && startCustomCheckout()}
                        disabled={buyBusy}
                        placeholder="custom amount"
                        aria-label="custom amount in dollars"
                        className="w-full bg-transparent outline-none placeholder:text-muted/70"
                      />
                    </div>
                    <button
                      onClick={startCustomCheckout}
                      disabled={buyBusy}
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
                      onClick={() => setBuyMethod("card")}
                      disabled={buyBusy}
                      aria-pressed={buyMethod === "card"}
                      className={`normal-case underline-offset-2 ${
                        buyMethod === "card"
                          ? "text-orange-deep underline"
                          : "text-muted hover:text-orange-deep"
                      }`}
                    >
                      card
                    </button>
                    <span className="text-muted">·</span>
                    <button
                      onClick={() => setBuyMethod("crypto")}
                      disabled={buyBusy}
                      aria-pressed={buyMethod === "crypto"}
                      className={`normal-case underline-offset-2 ${
                        buyMethod === "crypto"
                          ? "text-orange-deep underline"
                          : "text-muted hover:text-orange-deep"
                      }`}
                    >
                      crypto
                    </button>
                  </div>
                  {buyError && <p className="font-sans text-lg text-red">{buyError}</p>}
                  <button
                    onClick={() => setShowPacks(false)}
                    className="font-sans text-2xl underline hover:text-orange-deep"
                  >
                    {buyBusy ? "opening checkout…" : "maybe later"}
                  </button>
                </div>
              </div>
            </Overlay>
          )}
        </div>
      </div>
    </div>
  );
}

// Reads the X share boost claim back for the banner's active state; the
// utcDay comparison is what makes the 2x visibly expire at the reset.
function xSharedToday(): boolean {
  try {
    return localStorage.getItem("fb_x_boost") === utcDay();
  } catch {
    return false; // storage unavailable — the banner stays in its default state
  }
}

// Opens the X composer prefilled with the score and the flex-card link;
// the /s/[slug] page carries the OG image X renders under the post.
function shareOnX(product: PlayableProduct, best: number) {
  const cardUrl = `${window.location.origin}/s/${encodeURIComponent(product.slug)}`;
  // a real score leads with the number; a fresh 0 still claims the boost, so
  // give it a flex that doesn't read as bragging about nothing
  const text =
    best > 0
      ? `${best} flying for ${product.name} on flappybid.lol. the leaderboard money can't buy. beat it:`
      : `flying for ${product.name} on flappybid.lol. the leaderboard money can't buy. take a shot:`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(cardUrl)}`;
  window.open(intent, "_blank", "noopener");
}

function Overlay({
  children,
  dim = false,
}: {
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center ${
        dim ? "bg-scrim/40" : ""
      } pointer-events-none [&_button]:pointer-events-auto`}
    >
      {children}
    </div>
  );
}

