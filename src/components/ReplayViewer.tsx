"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WIDTH, HEIGHT, TICK_HZ } from "@/game/constants";
import { createSim, replay, step, type SimState } from "@/game/sim";
import { MAPS, isMapId } from "@/game/maps";
import { drawFrame } from "@/game/render";

// Ghost replay for champion review: re-runs the deterministic sim from the
// stored (seed, flapFrames) on the map the run was flown on — the same code
// path the server used to verify the score — and renders it exactly like the
// live game. Watching the bird is the review: solvers look wrong to a human
// even when their timing statistics pass every tell.

interface Props {
  seed: number;
  flapFrames: number[];
  /** shot inputs on combat maps; empty everywhere else */
  shootFrames?: number[];
  /** map id frozen on the run row; unknown/legacy values replay as classic */
  mapId: string;
}

const STEP_SEC = 1 / TICK_HZ;
const SPEEDS = [1, 2, 4, 8];
const NO_SHOTS: number[] = [];

export default function ReplayViewer({
  seed,
  flapFrames,
  shootFrames = NO_SHOTS,
  mapId,
}: Props) {
  const map = useMemo(
    () => (isMapId(mapId) ? MAPS[mapId] : MAPS.classic),
    [mapId]
  );
  // full pre-replay: total length for the seek bar, end score for the label
  const outcome = useMemo(
    () => replay(seed, flapFrames, shootFrames, map),
    [seed, flapFrames, shootFrames, map]
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimState | null>(null);
  const flapIdxRef = useRef(0);
  const shootIdxRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const rafRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [frame, setFrame] = useState(0);

  const setSpeed = (s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  };

  const play = (p: boolean) => {
    // replay finished — pressing play starts over
    if (p && simRef.current?.dead) seek(0);
    playingRef.current = p;
    setPlaying(p);
  };

  /** Step the sim forward, feeding recorded inputs by frame index. */
  const advance = (sim: SimState, steps: number) => {
    for (let i = 0; i < steps && !sim.dead; i++) {
      const flap =
        flapIdxRef.current < flapFrames.length &&
        flapFrames[flapIdxRef.current] === sim.frame;
      if (flap) flapIdxRef.current += 1;
      const shoot =
        shootIdxRef.current < shootFrames.length &&
        shootFrames[shootIdxRef.current] === sim.frame;
      if (shoot) shootIdxRef.current += 1;
      step(sim, flap, shoot);
    }
  };

  /** Jump anywhere by re-simulating from frame 0 — pure math, instant. */
  const seek = (target: number) => {
    const sim = createSim(seed, map);
    flapIdxRef.current = 0;
    shootIdxRef.current = 0;
    advance(sim, target);
    simRef.current = sim;
    setFrame(sim.frame);
  };

  // render loop
  useEffect(() => {
    simRef.current = createSim(seed, map);
    flapIdxRef.current = 0;
    shootIdxRef.current = 0;
    let last = performance.now();
    let acc = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const sim = simRef.current;
      const ctx = canvasRef.current?.getContext("2d");
      if (!sim || !ctx) return;

      if (playingRef.current && !sim.dead) {
        acc += dt * speedRef.current;
        const steps = Math.min(Math.floor(acc / STEP_SEC), 30 * speedRef.current);
        acc -= steps * STEP_SEC;
        advance(sim, steps);
        setFrame(sim.frame);
        if (sim.dead) {
          playingRef.current = false;
          setPlaying(false);
        }
      } else {
        acc = 0;
      }
      drawFrame(ctx, sim, { now, showScore: true });
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, flapFrames, shootFrames, map]);

  const ended = frame >= outcome.frames;

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="block w-full h-auto border-[3px] border-ink"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => play(!playing)}
          className="pixel-btn bg-orange text-white font-pixel text-[8px] px-3 py-1.5"
        >
          {playing ? "pause" : ended ? "replay" : "play"}
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`pixel-btn font-pixel text-[8px] px-2 py-1.5 ${
              speed === s ? "bg-gold" : "bg-paper"
            }`}
          >
            {s}x
          </button>
        ))}
        <span className="ml-auto text-sm text-muted tabular-nums">
          {Math.floor(frame / TICK_HZ)}s / {Math.ceil(outcome.frames / TICK_HZ)}s
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={outcome.frames}
        value={frame}
        onChange={(e) => {
          play(false);
          seek(Number(e.target.value));
        }}
        className="w-full mt-2 accent-orange-deep"
        aria-label="Seek replay"
      />
    </div>
  );
}
