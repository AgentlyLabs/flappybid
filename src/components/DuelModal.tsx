"use client";

// The duel pit, end to end: record a fight script against the practice
// dummy, then either post it as a ghost (post mode), fight it against a
// ghost and watch the reveal (accept mode), or replay any resolved fight
// (watch mode). One fixed-timestep loop drives all three — the same
// deterministic sim the server judges with (src/game/duel.ts), so the fight
// you watch is the fight that was scored.

import { useCallback, useEffect, useRef, useState } from "react";
import { WIDTH, HEIGHT, TICK_HZ } from "@/game/constants";
import {
  ACT_ATTACK,
  ACT_EQ_BLADE,
  ACT_EQ_EGG,
  ACT_EQ_FEATHER,
  ACT_FLAP,
  ACT_LEFT,
  ACT_PROT_BEAK,
  ACT_PROT_EGG,
  ACT_PROT_FEATHER,
  ACT_PROT_OFF,
  ACT_RIGHT,
  ACT_SPEC,
  DUEL_VERSION,
  SPEC_MAX,
  createDuel,
  dummyScript,
  normalizeRuleset,
  practiceBot,
  stepDuel,
  type DuelRuleset,
  type DuelScript,
  type DuelState,
} from "@/game/duel";
import { drawDuelFrame } from "@/game/duelRender";
import { sfx } from "@/game/sound";
import { ensureHuman } from "@/lib/human-client";

const STEP_SEC = 1 / TICK_HZ;
const MIN_RECORD_FRAMES = 300; // 5s — shorter ghosts are just target practice

// ---- the tutorial reel ------------------------------------------------------
//
// The "video" behind the practice intro is a choreographed fight running in
// the real sim: two frame-scripted birds demonstrate each mechanic in order
// while captions keep pace. Being the actual engine, the footage can never
// drift from how the game really plays.

function demoHover(st: DuelState, i: number): number {
  const f = st.fighters[i];
  return f.velY > 2 || f.y > 420 ? ACT_FLAP : 0;
}

/** RED (left): the aggressor walking through the arsenal. */
function demoRed(st: DuelState): number {
  const fr = st.frame;
  const f = st.fighters[0];
  const o = st.fighters[1];
  let mask = demoHover(st, 0);
  const ready = f.attackCd === 0 && f.switchLock === 0;
  if (fr === 180) mask |= ACT_EQ_FEATHER;
  if (fr >= 200 && fr < 660 && fr % 130 === 20 && ready) mask |= ACT_ATTACK;
  if (fr === 940) mask |= ACT_EQ_EGG;
  if (fr >= 960 && fr < 1200 && fr % 100 === 60 && ready) mask |= ACT_ATTACK;
  if (fr >= 1200 && ready) mask |= ACT_ATTACK;
  if (fr >= 1200 && fr % 90 === 45) mask |= o.x > f.x ? ACT_RIGHT : ACT_LEFT;
  if (f.spec >= SPEC_MAX) mask |= ACT_SPEC;
  return mask;
}

/** BLUE (right): dodges, flicks protect, answers with the blade. */
function demoBlue(st: DuelState): number {
  const fr = st.frame;
  const f = st.fighters[1];
  const o = st.fighters[0];
  let mask = demoHover(st, 1);
  const ready = f.attackCd === 0 && f.switchLock === 0;
  const inRange = () => {
    const dx = o.x - f.x;
    const dy = o.y - f.y;
    return dx * dx + dy * dy < 150 * 150;
  };
  if (fr >= 180 && fr < 420 && fr % 14 === 0) {
    mask |= Math.floor(fr / 42) % 2 === 0 ? ACT_LEFT : ACT_RIGHT;
  }
  if (fr === 430) mask |= ACT_PROT_FEATHER;
  if (fr === 665) mask |= ACT_PROT_OFF;
  if (fr === 670) mask |= ACT_EQ_BLADE;
  if ((fr >= 680 && fr < 930) || fr >= 1200) {
    if (fr % 4 === 0) mask |= o.x > f.x ? ACT_RIGHT : ACT_LEFT;
    // a few teaching lunges mid-reel, full aggression in the finale
    if (ready && inRange() && (fr >= 1200 || fr % 90 < 8)) mask |= ACT_ATTACK;
  }
  if (fr >= 930 && fr < 1200 && fr % 30 === 0) {
    // duck behind the center pillar — the mortar scene is about cover
    mask |= f.x > WIDTH / 2 + 40 ? ACT_LEFT : ACT_RIGHT;
  }
  if (f.spec >= SPEC_MAX && fr > 1200) mask |= ACT_SPEC;
  return mask;
}

/** Spec bars start warm so the reel reliably reaches its laser finale
 *  inside ~22s — everything else plays by the real rules. */
function makeDemo(): DuelState {
  const demo = createDuel();
  demo.fighters[0].spec = 60;
  demo.fighters[1].spec = 50;
  return demo;
}

const DEMO_CAPTIONS: Array<[number, string]> = [
  [0, "a duel: your recording vs theirs — here's one playing out"],
  [180, "attacks aim themselves — dodging is flying. red opens with feathers"],
  [420, "blue flicks protect-from-feathers: 80% blocked, but it drains focus"],
  [660, "the beak blade: close the distance, lunge for big damage"],
  [930, "the egg mortar arcs at you — stone cover is the only shield"],
  [1200, "in the open, damage charges spec fast — full bar fires the mega laser"],
];

function demoCaptionAt(frame: number): string {
  let text = DEMO_CAPTIONS[0][1];
  for (const [from, t] of DEMO_CAPTIONS) {
    if (frame >= from) text = t;
  }
  return text;
}

export interface OpenDuel {
  id: string;
  nickname: string;
  taunt: string | null;
  ruleset: DuelRuleset;
  mode: string;
}

export type DuelModalMode =
  | { kind: "post" }
  | { kind: "accept"; duel: OpenDuel }
  | { kind: "watch"; matchId: string }
  | { kind: "practice" };

interface Verdict {
  winner: "ghost" | "challenger" | "draw";
  ko: boolean;
  frames: number;
  ghostHp: number;
  challengerHp: number;
  ghostDmg: number;
  challengerDmg: number;
}

type Phase =
  | "rules" // post: pick your terms
  | "howto" // practice: the tutorial card
  | "briefing" // accept: the ghost's card
  | "starting" // fetching the start token
  | "recording"
  | "form" // post: name + taunt
  | "posting"
  | "posted"
  | "resolving" // accept: server merges the fight
  | "reveal" // the merged fight plays out
  | "result"
  | "loading" // watch: fetching scripts
  | "error";

interface RevealData {
  scriptA: DuelScript;
  scriptB: DuelScript;
  ruleset: DuelRuleset;
  names: [string, string];
  me: 0 | 1 | -1;
  verdict: Verdict;
}

function loadName(): string {
  try {
    return localStorage.getItem("fb_duel_name") ?? "";
  } catch {
    return "";
  }
}

function rememberGhost(duelId: string, ownerToken: string, nickname: string) {
  try {
    const raw = localStorage.getItem("fb_my_duels");
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.push({ duelId, ownerToken, nickname, at: Date.now() });
    localStorage.setItem("fb_my_duels", JSON.stringify(list.slice(-20)));
  } catch {
    // no storage, no withdraw button — the ghost still fights
  }
}

/** Walks a script's [frame, mask] pairs as the sim advances. */
function scriptWalker(script: DuelScript) {
  let i = 0;
  return (frame: number): number => {
    if (i < script.length && script[i] === frame) {
      const mask = script[i + 1];
      i += 2;
      return mask;
    }
    return 0;
  };
}

export default function DuelModal({
  mode,
  onClose,
  onChanged,
  onPost,
}: {
  mode: DuelModalMode;
  onClose: () => void;
  onChanged: () => void;
  /** practice result's "post a real challenge" shortcut */
  onPost?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    mode.kind === "post"
      ? "rules"
      : mode.kind === "accept"
        ? "briefing"
        : mode.kind === "practice"
          ? "howto"
          : "loading"
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [ruleset, setRuleset] = useState<DuelRuleset>(normalizeRuleset({}));
  const [expiryHours, setExpiryHours] = useState(72);
  const [postMode, setPostMode] = useState<"gauntlet" | "first_blood">("gauntlet");
  const [nickname, setNickname] = useState(loadName);
  const [taunt, setTaunt] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [revealNames, setRevealNames] = useState<[string, string]>(["", ""]);
  const [revealMe, setRevealMe] = useState<0 | 1 | -1>(-1);
  const [speed, setSpeed] = useState(1);
  const [recordedFrames, setRecordedFrames] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<Phase>(phase);
  const stateRef = useRef<DuelState | null>(null);
  const scriptRef = useRef<DuelScript>([]);
  const pendingRef = useRef(0);
  const walkerARef = useRef<((f: number) => number) | null>(null);
  const walkerBRef = useRef<((f: number) => number) | null>(null);
  const startTokenRef = useRef("");
  const revealRef = useRef<RevealData | null>(null);
  const speedRef = useRef(1);
  const rafRef = useRef(0);
  const protectRef = useRef(0); // last protect the C-cycle landed on
  const doneRef = useRef(false);
  const practiceRef = useRef(false); // sparring: bot opponent, nothing sent
  const botScriptRef = useRef<DuelScript>([]); // bot's moves, for rewatch
  const demoRef = useRef<DuelState | null>(null); // the tutorial reel's sim
  const demoHoldRef = useRef(0); // frames the end banner lingers before looping
  const [demoCaption, setDemoCaption] = useState(DEMO_CAPTIONS[0][1]);

  // the rAF loop reads these; keep them in step with the state they mirror
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const fail = useCallback((msg: string) => {
    setErrorMsg(msg);
    setPhase("error");
  }, []);

  // ---- the reveal player -------------------------------------------------

  const startReveal = useCallback(() => {
    const r = revealRef.current;
    if (!r) return;
    stateRef.current = createDuel(r.ruleset);
    walkerARef.current = scriptWalker(r.scriptA);
    walkerBRef.current = scriptWalker(r.scriptB);
    setVerdict(r.verdict);
    setRevealNames(r.names);
    setRevealMe(r.me);
    setPhase("reveal");
  }, []);

  // ---- start recording: mint the start token, spin up sim vs dummy -------

  const beginRecording = useCallback(async () => {
    setPhase("starting");
    const rules =
      mode.kind === "accept" ? mode.duel.ruleset : ruleset;
    practiceRef.current = mode.kind === "practice";
    // sparring is entirely client-side — no token, nothing to submit
    if (mode.kind !== "practice") {
      try {
        let res = await fetch("/api/duel/start", { method: "POST" });
        let data = await res.json();
        if (!res.ok && data.humanCheck && (await ensureHuman())) {
          res = await fetch("/api/duel/start", { method: "POST" });
          data = await res.json();
        }
        if (!res.ok) return fail(data.error ?? "couldn't enter the pit");
        if (data.duelVersion !== DUEL_VERSION) {
          return fail("the arena was updated — refresh the page");
        }
        startTokenRef.current = data.t;
      } catch {
        return fail("network hiccup — try again");
      }
    }
    botScriptRef.current = [];
    scriptRef.current = [];
    pendingRef.current = 0;
    protectRef.current = 0;
    doneRef.current = false;
    stateRef.current = createDuel(rules);
    walkerBRef.current = scriptWalker(dummyScript());
    setRecordedFrames(0);
    setPhase("recording");
  }, [mode, ruleset, fail]);

  // ---- recording finished → next step per mode ---------------------------

  const finishRecording = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (mode.kind === "practice") {
      // the verdict is whatever the sim just said — nothing leaves the tab
      const st = stateRef.current;
      if (!st) return;
      revealRef.current = {
        scriptA: scriptRef.current,
        scriptB: botScriptRef.current,
        ruleset: st.ruleset,
        names: ["YOU", "BOT"],
        me: 0,
        verdict: {
          winner:
            st.winner === 0 ? "ghost" : st.winner === 1 ? "challenger" : "draw",
          ko: st.fighters[0].hp === 0 || st.fighters[1].hp === 0,
          frames: st.frame,
          ghostHp: st.fighters[0].hp,
          challengerHp: st.fighters[1].hp,
          ghostDmg: st.fighters[0].dmgDealt,
          challengerDmg: st.fighters[1].dmgDealt,
        },
      };
      const r = revealRef.current;
      setVerdict(r.verdict);
      setRevealNames(r.names);
      setRevealMe(0);
      setPhase("result");
      return;
    }
    if (mode.kind === "post") {
      setPhase("form");
      return;
    }
    if (mode.kind !== "accept") return;
    setPhase("resolving");
    (async () => {
      try {
        const res = await fetch("/api/duel/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duelId: mode.duel.id,
            nickname: nickname || "CHALLENGER",
            script: scriptRef.current,
            duelVersion: DUEL_VERSION,
            startToken: startTokenRef.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) return fail(data.error ?? "the fight fell through");
        onChanged();
        revealRef.current = {
          scriptA: data.ghost.script,
          scriptB: scriptRef.current,
          ruleset: data.ruleset,
          names: [data.ghost.nickname, nickname || "CHALLENGER"],
          me: 1,
          verdict: data.verdict,
        };
        startReveal();
      } catch {
        fail("network hiccup — the fight may not have counted");
      }
    })();
  }, [mode, nickname, onChanged, fail, startReveal]);

  // ---- watch mode: fetch a resolved fight --------------------------------

  useEffect(() => {
    if (mode.kind !== "watch") return;
    (async () => {
      try {
        const res = await fetch(`/api/duel/fight?matchId=${mode.matchId}`);
        const data = await res.json();
        if (!res.ok) return fail(data.error ?? "fight not found");
        revealRef.current = {
          scriptA: data.ghost.script,
          scriptB: data.challenger.script,
          ruleset: data.ruleset,
          names: [data.ghost.nickname, data.challenger.nickname],
          me: -1,
          verdict: data.verdict,
        };
        startReveal();
      } catch {
        fail("network hiccup — try again");
      }
    })();
  }, [mode, startReveal, fail]);

  // ---- post the ghost ----------------------------------------------------

  const postGhost = useCallback(async () => {
    const name = nickname.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,12}$/.test(name)) {
      setErrorMsg("bird name: 3–12 letters, numbers, - or _");
      return;
    }
    setErrorMsg("");
    setPhase("posting");
    try {
      localStorage.setItem("fb_duel_name", name);
    } catch {
      // fine
    }
    try {
      const res = await fetch("/api/duel/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: name,
          taunt: taunt || undefined,
          ruleset,
          mode: postMode,
          expiryHours,
          script: scriptRef.current,
          duelVersion: DUEL_VERSION,
          startToken: startTokenRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhase("form");
        setErrorMsg(data.error ?? "couldn't post the ghost");
        return;
      }
      rememberGhost(data.duelId, data.ownerToken, name);
      onChanged();
      setPhase("posted");
    } catch {
      setPhase("form");
      setErrorMsg("network hiccup — try again");
    }
  }, [nickname, taunt, ruleset, postMode, expiryHours, onChanged]);

  // ---- inputs ------------------------------------------------------------

  const press = useCallback((bit: number) => {
    if (phaseRef.current !== "recording") return;
    pendingRef.current |= bit;
    if (bit & (ACT_FLAP | ACT_LEFT | ACT_RIGHT)) sfx.flap();
    if (bit & ACT_ATTACK) sfx.shoot();
  }, []);

  const cycleProtect = useCallback(() => {
    const next = (protectRef.current + 1) % 4;
    protectRef.current = next;
    press(
      [ACT_PROT_OFF, ACT_PROT_BEAK, ACT_PROT_FEATHER, ACT_PROT_EGG][next]
    );
  }, [press]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== "recording") return;
      if (e.repeat) return;
      switch (e.code) {
        case "Space":
        case "ArrowUp":
        case "KeyW":
          e.preventDefault();
          press(ACT_FLAP);
          break;
        case "ArrowLeft":
        case "KeyA":
          e.preventDefault();
          press(ACT_LEFT);
          break;
        case "ArrowRight":
        case "KeyD":
          e.preventDefault();
          press(ACT_RIGHT);
          break;
        case "KeyX":
        case "KeyJ":
          press(ACT_ATTACK);
          break;
        case "Digit1":
          press(ACT_EQ_BLADE);
          break;
        case "Digit2":
          press(ACT_EQ_FEATHER);
          break;
        case "Digit3":
          press(ACT_EQ_EGG);
          break;
        case "KeyC":
          cycleProtect();
          break;
        case "KeyF":
          press(ACT_SPEC);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, cycleProtect]);

  // ---- the loop ----------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    let last = performance.now();
    let acc = 0;
    let demoAcc = 0;
    let lastCaption = "";

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const ph = phaseRef.current;

      // the tutorial reel: a looping choreographed fight behind the intro
      if (ph === "howto") {
        if (!demoRef.current) demoRef.current = makeDemo();
        const demo = demoRef.current;
        if (!demo.over) {
          demoAcc += dt;
          while (demoAcc >= STEP_SEC && !demo.over) {
            demoAcc -= STEP_SEC;
            stepDuel(demo, demoRed(demo), demoBlue(demo));
          }
          const caption = demoCaptionAt(demo.frame);
          if (caption !== lastCaption) {
            lastCaption = caption;
            setDemoCaption(caption);
          }
        } else if (++demoHoldRef.current > 150) {
          // hold the K.O. for a beat, then roll the reel again
          demoRef.current = makeDemo();
          demoHoldRef.current = 0;
          demoAcc = 0;
        }
        drawDuelFrame(ctx, demo, {
          now,
          names: ["RED", "BLUE"],
          me: -1,
          banner: demo.over ? "THAT'S A DUEL!" : null,
          subBanner: demo.over ? "your turn — spar the bot below" : null,
        });
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const st = stateRef.current;

      if (st && (ph === "recording" || ph === "reveal") && !st.over) {
        acc += dt * (ph === "reveal" ? speedRef.current : 1);
        const hitsBefore = st.hits.length;
        while (acc >= STEP_SEC && !st.over) {
          acc -= STEP_SEC;
          if (ph === "recording") {
            const mask = pendingRef.current;
            pendingRef.current = 0;
            if (mask !== 0) scriptRef.current.push(st.frame, mask);
            // sparring fights the reactive bot; real recordings spar the
            // scripted dummy (what your ghost's opponents see is blind too)
            const dmask = practiceRef.current
              ? practiceBot(st, 1)
              : (walkerBRef.current?.(st.frame) ?? 0);
            if (dmask !== 0) botScriptRef.current.push(st.frame, dmask);
            stepDuel(st, mask, dmask);
          } else {
            const ma = walkerARef.current?.(st.frame) ?? 0;
            const mb = walkerBRef.current?.(st.frame) ?? 0;
            stepDuel(st, ma, mb);
          }
        }
        if (st.hits.length > hitsBefore) sfx.zap();
        // the DONE countdown only needs ~4 updates a second, not 60
        if (ph === "recording" && st.frame % 15 === 0) setRecordedFrames(st.frame);
        if (st.over) {
          sfx.die();
          if (ph === "recording") finishRecording();
          else setPhase("result");
        }
      }

      if (st) {
        const over = st.over && ph !== "recording";
        const v = verdict;
        let banner: string | null = null;
        let sub: string | null = null;
        if (over && v && (ph === "reveal" || ph === "result")) {
          const winnerName =
            v.winner === "draw"
              ? null
              : revealNames[v.winner === "ghost" ? 0 : 1];
          banner =
            winnerName === null
              ? "DRAW!"
              : winnerName === "YOU"
                ? "YOU TAKE IT"
                : `${winnerName} TAKES IT`;
          sub = v.ko
            ? `K.O. — damage ${v.ghostDmg} / ${v.challengerDmg}`
            : `time! — damage ${v.ghostDmg} / ${v.challengerDmg}`;
        }
        drawDuelFrame(ctx, st, {
          now,
          names:
            ph === "recording"
              ? ["YOU", practiceRef.current ? "BOT" : "DUMMY"]
              : revealNames[0]
                ? revealNames
                : ["GHOST", "CHALLENGER"],
          me: ph === "recording" ? 0 : revealMe,
          banner,
          subBanner: sub,
        });
      } else {
        ctx.fillStyle = "#26221c";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [finishRecording, verdict, revealNames, revealMe]);

  // ---- chrome ------------------------------------------------------------

  const rulesetChips = (r: DuelRuleset) =>
    [
      r.bladesOnly && "blades only",
      r.noProtect && "no protects",
      r.noSpec && "no spec",
      r.suddenDeath && "sudden death",
    ].filter(Boolean) as string[];

  const toggle = (key: keyof DuelRuleset) =>
    setRuleset((r) => ({ ...r, [key]: !r[key] }));

  const recording = phase === "recording";
  const canFinish = recordedFrames >= MIN_RECORD_FRAMES;

  return (
    <div className="fixed inset-0 z-50 flex bg-scrim/60 overscroll-contain sm:items-center sm:justify-center sm:p-4">
      <div className="bg-paper flex flex-col w-full h-[100dvh] overflow-hidden sm:h-auto sm:max-w-[420px] sm:border-4 sm:border-ink sm:shadow-[6px_6px_0_rgba(0,0,0,0.35)]">
        <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-sand border-b-4 border-ink pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-base leading-none text-muted">
              {mode.kind === "post"
                ? "the dueling grounds"
                : mode.kind === "accept"
                  ? "duel against"
                  : "watching"}
            </p>
            <p className="font-pixel text-[11px] truncate mt-1.5">
              {mode.kind === "accept"
                ? mode.duel.nickname
                : mode.kind === "post"
                  ? "POST YOUR GHOST"
                  : mode.kind === "practice"
                    ? "PRACTICE ROUND"
                    : revealNames[0]
                      ? `${revealNames[0]} vs ${revealNames[1]}`
                      : "…"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="font-pixel text-sm px-3 py-2 -mr-2 hover:text-orange-deep"
            aria-label="Close"
          >
            X
          </button>
        </div>

        <div className="relative flex-1 min-h-0 bg-scrim flex items-center justify-center sm:flex-none sm:bg-paper sm:block">
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            onPointerDown={(e) => {
              if (!recording) return;
              e.preventDefault();
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              const x = (e.clientX - rect.left) / rect.width;
              press(x < 0.35 ? ACT_LEFT : x > 0.65 ? ACT_RIGHT : ACT_FLAP);
            }}
            className="block touch-none select-none cursor-pointer max-w-full max-h-full sm:w-full sm:h-auto sm:max-h-none"
          />

          {recording && (
            <>
              <div className="absolute bottom-16 right-3 flex flex-col gap-2">
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    press(ACT_ATTACK);
                  }}
                  className="pixel-btn bg-red text-white font-pixel text-[10px] px-4 py-3 touch-none select-none"
                >
                  ATK
                </button>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    cycleProtect();
                  }}
                  className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3 touch-none select-none"
                >
                  ⛨
                </button>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    press(ACT_SPEC);
                  }}
                  className="pixel-btn bg-gold font-pixel text-[10px] px-4 py-3 touch-none select-none"
                >
                  SPEC
                </button>
              </div>
              <div className="absolute bottom-16 left-3 flex gap-1">
                {([ACT_EQ_BLADE, ACT_EQ_FEATHER, ACT_EQ_EGG] as const).map(
                  (bit, i) => (
                    <button
                      key={bit}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        press(bit);
                      }}
                      className="pixel-btn bg-paper font-pixel text-[10px] px-3 py-3 touch-none select-none"
                    >
                      {i + 1}
                    </button>
                  )
                )}
              </div>
              {mode.kind !== "practice" && (
                <button
                  onClick={finishRecording}
                  disabled={!canFinish}
                  className="absolute top-14 right-3 pixel-btn bg-orange text-white font-pixel text-[9px] px-3 py-2 disabled:opacity-40"
                >
                  {canFinish
                    ? mode.kind === "post"
                      ? "DONE ✓"
                      : "FIGHT ▶"
                    : `${Math.ceil((MIN_RECORD_FRAMES - recordedFrames) / 60)}s…`}
                </button>
              )}
            </>
          )}

          {phase === "howto" && (
            <>
              <div className="absolute top-14 left-0 right-0 flex justify-center pointer-events-none">
                <p className="font-pixel text-[10px] text-white text-outline bg-scrim/60 px-3 py-2">
                  📼 HOW DUELS WORK
                </p>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-scrim/75 px-4 pt-3 pb-4 text-center">
                <p className="text-lg text-white text-outline min-h-12 mb-2">
                  {demoCaption}
                </p>
                <div className="flex justify-center items-center gap-3">
                  <button
                    onClick={beginRecording}
                    className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-3"
                  >
                    🥊 SPAR THE BOT
                  </button>
                </div>
                <p className="font-pixel text-[8px] text-white text-outline mt-3">
                  space fly · ←/→ dart · X attack · 1/2/3 weapons · C protect ·
                  F spec
                </p>
                <p className="text-base text-white/80 text-outline mt-1">
                  just practice — nothing is posted, nothing is scored.
                </p>
              </div>
            </>
          )}

          {phase === "rules" && mode.kind === "post" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-lg text-gold text-outline mb-2">
                  SET YOUR TERMS
                </p>
                <p className="text-lg text-white text-outline mb-4">
                  you&apos;ll spar the practice dummy — every move is recorded as
                  your ghost. attacks aim themselves; you bring the timing.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mb-4">
                  {(
                    [
                      ["bladesOnly", "blades only"],
                      ["noProtect", "no protects"],
                      ["noSpec", "no spec"],
                      ["suddenDeath", "sudden death"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => toggle(key)}
                      className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                        ruleset[key] ? "bg-gold" : "bg-paper"
                      }`}
                    >
                      {ruleset[key] ? "✓ " : ""}
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-center gap-2 mb-4">
                  {[24, 72, 168].map((h) => (
                    <button
                      key={h}
                      onClick={() => setExpiryHours(h)}
                      className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                        expiryHours === h ? "bg-gold" : "bg-paper"
                      }`}
                    >
                      {h === 24 ? "24H" : h === 72 ? "3 DAYS" : "7 DAYS"}
                    </button>
                  ))}
                </div>
                <div className="flex justify-center gap-2 mb-6">
                  <button
                    onClick={() => setPostMode("gauntlet")}
                    className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                      postMode === "gauntlet" ? "bg-gold" : "bg-paper"
                    }`}
                  >
                    GAUNTLET
                  </button>
                  <button
                    onClick={() => setPostMode("first_blood")}
                    className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
                      postMode === "first_blood" ? "bg-gold" : "bg-paper"
                    }`}
                  >
                    FIRST BLOOD
                  </button>
                </div>
                <button
                  onClick={beginRecording}
                  className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-4"
                >
                  ⚔ ENTER THE PIT
                </button>
              </div>
            </Overlay>
          )}

          {phase === "briefing" && mode.kind === "accept" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-lg text-gold text-outline mb-3">
                  {mode.duel.nickname}
                </p>
                {mode.duel.taunt && (
                  <p className="text-xl text-white text-outline italic mb-3">
                    “{mode.duel.taunt}”
                  </p>
                )}
                {rulesetChips(mode.duel.ruleset).length > 0 && (
                  <p className="font-pixel text-[9px] text-white text-outline mb-3">
                    {rulesetChips(mode.duel.ruleset).join(" · ")}
                  </p>
                )}
                <p className="text-lg text-white text-outline mb-2">
                  you&apos;ll fight the practice dummy — blind. your recording then
                  faces this ghost’s, and the pit decides. one shot.
                </p>
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value.toUpperCase())}
                  placeholder="YOUR BIRD NAME"
                  maxLength={12}
                  className="border-4 border-ink bg-paper px-3 py-2 text-center font-pixel text-[10px] mb-4 w-52"
                />
                <div>
                  <button
                    onClick={beginRecording}
                    disabled={!/^[A-Z0-9_-]{3,12}$/.test(nickname)}
                    className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-4 disabled:opacity-40"
                  >
                    ⚔ ACCEPT DUEL
                  </button>
                </div>
              </div>
            </Overlay>
          )}

          {(phase === "starting" ||
            phase === "resolving" ||
            phase === "posting" ||
            phase === "loading") && (
            <Overlay>
              <p className="font-pixel text-[10px] text-white text-outline">
                {phase === "resolving"
                  ? "the pit decides…"
                  : phase === "posting"
                    ? "raising your ghost…"
                    : "entering the pit…"}
              </p>
            </Overlay>
          )}

          {phase === "form" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-lg text-gold text-outline mb-2">
                  SIGN YOUR GHOST
                </p>
                <p className="text-lg text-white text-outline mb-4">
                  {Math.floor(recordedFrames / 60)}s of moves recorded
                </p>
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value.toUpperCase())}
                  placeholder="BIRD NAME"
                  maxLength={12}
                  className="border-4 border-ink bg-paper px-3 py-2 text-center font-pixel text-[10px] mb-3 w-52 block mx-auto"
                />
                <input
                  value={taunt}
                  onChange={(e) => setTaunt(e.target.value)}
                  placeholder="taunt (optional)"
                  maxLength={64}
                  className="border-4 border-ink bg-paper px-3 py-2 text-center text-lg mb-4 w-64 block mx-auto"
                />
                {errorMsg && (
                  <p className="text-lg text-red text-outline mb-3">{errorMsg}</p>
                )}
                <div className="flex justify-center gap-3">
                  <button
                    onClick={postGhost}
                    className="pixel-btn bg-orange text-white font-pixel text-xs px-5 py-3"
                  >
                    ⚔ POST IT
                  </button>
                  <button
                    onClick={beginRecording}
                    className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
                  >
                    ↺ RE-FLY
                  </button>
                </div>
              </div>
            </Overlay>
          )}

          {phase === "posted" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-xl text-gold text-outline mb-3">
                  GHOST RAISED
                </p>
                <p className="text-xl text-white text-outline mb-6">
                  your bird now fights for you, even while you sleep. results
                  land on the duel board.
                </p>
                <button
                  onClick={onClose}
                  className="pixel-btn bg-orange text-white font-pixel text-xs px-6 py-3"
                >
                  TO THE BOARD
                </button>
              </div>
            </Overlay>
          )}

          {phase === "result" && verdict && (
            <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-2 flex-wrap px-2">
              {mode.kind === "practice" && (
                <button
                  onClick={beginRecording}
                  className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
                >
                  🥊 REMATCH
                </button>
              )}
              <button
                onClick={startReveal}
                className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
              >
                ↺ REWATCH
              </button>
              <button
                onClick={() => setSpeed((s) => (s === 1 ? 2 : 1))}
                className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
              >
                {speed === 1 ? "2X" : "1X"}
              </button>
              {mode.kind === "practice" && onPost ? (
                <button
                  onClick={onPost}
                  className="pixel-btn bg-orange text-white font-pixel text-[10px] px-4 py-3"
                >
                  ⚔ POST A REAL ONE
                </button>
              ) : (
                <button
                  onClick={onClose}
                  className="pixel-btn bg-orange text-white font-pixel text-[10px] px-4 py-3"
                >
                  DONE
                </button>
              )}
            </div>
          )}

          {phase === "error" && (
            <Overlay>
              <div className="text-center px-6">
                <p className="font-pixel text-sm text-red text-outline mb-4">
                  {errorMsg}
                </p>
                <button
                  onClick={onClose}
                  className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3"
                >
                  CLOSE
                </button>
              </div>
            </Overlay>
          )}
        </div>

        {recording && (
          <div className="shrink-0 px-4 py-2 bg-sand border-t-4 border-ink text-center text-base text-muted pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            tap sides to dart · space/←/→ fly · X attack · 1/2/3 weapons · C
            protect · F spec
          </div>
        )}
      </div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-scrim/50">
      {children}
    </div>
  );
}
