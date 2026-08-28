// Deterministic fixed-timestep Flappy Bird simulation.
//
// The client advances this sim frame by frame (rendering on top of it) and
// records the frame index of every flap (and, on combat maps, every shot).
// The server replays the exact same sim from (seed, flapFrames, shootFrames,
// map) and derives the authoritative score. All state is plain numbers
// driven by integer frame counts — no wall-clock time, no floating-point
// entropy sources — so both sides agree bit-for-bit.
//
// Map physics come from maps.ts; the map is itself derived from the run's
// UTC day, never chosen by the client. IMPORTANT: only IEEE-exact operations
// (+ - * / min max floor) belong in here. Math.sin & co. differ in the last
// ulp between JS engines, which is enough to flip a collision and turn an
// honest run into a "score mismatch" ban — hence the polynomial wave().

import {
  WIDTH,
  BIRD_X,
  BIRD_RADIUS,
  BIRD_START_Y,
  PIPE_WIDTH,
  FIRST_PIPE_X,
  FLOOR_Y,
  REVIVE_INVULN_FRAMES,
  BULLET_SPEED,
  BULLET_RADIUS,
  TARGET_RADIUS,
  TARGET_Y_MIN,
  TARGET_Y_MAX,
  LASER_HALF_WIDTH,
  BEAM_HALF_HEIGHT,
} from "./constants";
import { MAPS, type MapDef } from "./maps";
import { mulberry32 } from "./rng";

/** Floating bonus object between two pipes; shoot it for TARGET_BONUS. */
export interface Target {
  /** world-space x of the target's center at frame 0 */
  x0: number;
  y: number;
  hit: boolean;
}

/** A fired bullet, in screen space (it outruns the scroll). */
export interface Bullet {
  x: number;
  y: number;
}

export interface Pipe {
  /** world-space x of the pipe's left edge at frame 0 */
  x0: number;
  /** sway midpoint (the center itself on static maps) */
  gapCenter: number;
  /** sway cycle offset in [0,1); 0 on static maps */
  wavePhase: number;
  /** bonus target in the half-segment behind this pipe (combat maps only) */
  target: Target | null;
  /** laser gate across this pipe's gap: cycle offset in frames, or none */
  laserOffset: number | null;
}

export interface SimState {
  frame: number;
  birdY: number;
  velY: number;
  scrolled: number;
  score: number;
  dead: boolean;
  /** frames of post-revive grace left; while >0 nothing can kill the bird */
  invuln: number;
  pipes: Pipe[];
  bullets: Bullet[];
  /** points earned from shot-down targets, folded into score */
  bonus: number;
  /** frames until the weapon can fire again */
  cooldown: number;
  /** frame the mega-laser last fired, and the height it swept (beam maps) */
  lastBeam: number;
  lastBeamY: number;
  rng: () => number;
  map: MapDef;
}

export function createSim(seed: number, map: MapDef = MAPS.classic): SimState {
  return {
    frame: 0,
    birdY: BIRD_START_Y,
    velY: 0,
    scrolled: 0,
    score: 0,
    dead: false,
    invuln: 0,
    pipes: [],
    bullets: [],
    bonus: 0,
    cooldown: 0,
    lastBeam: -9999,
    lastBeamY: 0,
    rng: mulberry32(seed),
    map,
  };
}

/** Where the next pipe's gap center lands, per the map's pattern. The rng
 *  draw count per pipe is fixed per map, so layouts stay reproducible. */
function nextGapCenter(state: SimState): number {
  const m = state.map;
  const lo = m.gapCenterMin + m.waveAmp;
  const hi = m.gapCenterMax - m.waveAmp;
  if (m.zigzag) {
    const band = (hi - lo) * 0.3;
    return state.pipes.length % 2 === 0
      ? lo + state.rng() * band
      : hi - band + state.rng() * band;
  }
  if (m.meanderStep !== null && state.pipes.length > 0) {
    const prev = state.pipes[state.pipes.length - 1].gapCenter;
    const c = prev + (state.rng() * 2 - 1) * m.meanderStep;
    return Math.max(lo, Math.min(hi, c));
  }
  return lo + state.rng() * (hi - lo);
}

/** Lazily extend the pipe list so pipe i always exists before it's visible. */
function ensurePipes(state: SimState, uptoIndex: number) {
  while (state.pipes.length <= uptoIndex) {
    const i = state.pipes.length;
    const gapCenter = nextGapCenter(state);
    const wavePhase = state.map.waveAmp > 0 ? state.rng() : 0;
    const x0 = FIRST_PIPE_X + i * state.map.pipeSpacing;
    // combat draws happen unconditionally so the per-pipe rng draw count
    // stays fixed whatever the presence rolls land on
    let target: Target | null = null;
    let laserOffset: number | null = null;
    const c = state.map.combat;
    if (c) {
      const targetRoll = state.rng();
      const targetY = state.rng();
      if (targetRoll < c.targetChance) {
        target = {
          x0: x0 + state.map.pipeSpacing / 2,
          y: TARGET_Y_MIN + targetY * (TARGET_Y_MAX - TARGET_Y_MIN),
          hit: false,
        };
      }
      if (c.laserChance > 0) {
        const laserRoll = state.rng();
        const laserPhase = state.rng();
        if (laserRoll < c.laserChance) {
          laserOffset = Math.floor(laserPhase * c.laserPeriod);
        }
      }
    }
    state.pipes.push({ x0, gapCenter, wavePhase, target, laserOffset });
  }
}

/** Current screen-space x of a pipe's left edge. */
export function pipeX(state: SimState, pipe: Pipe): number {
  return pipe.x0 - state.scrolled;
}

// Smoothed triangle wave in [-1, 1] over t in cycles. Sine-like to the eye,
// but built only from IEEE-exact ops so every engine agrees bit-for-bit.
function wave(t: number): number {
  const f = t - Math.floor(t);
  const tri = f < 0.5 ? f * 4 - 1 : 3 - f * 4;
  return tri * (1.5 - 0.5 * tri * tri);
}

/** The gap's center on this exact frame (pipes sway on some maps). */
export function gapCenterAt(state: SimState, pipe: Pipe): number {
  const m = state.map;
  if (m.waveAmp === 0) return pipe.gapCenter;
  return (
    pipe.gapCenter +
    m.waveAmp * wave(pipe.wavePhase + state.frame / m.wavePeriod)
  );
}

/**
 * Where a pipe's laser gate is in its warn→fire→idle cycle this frame.
 * "warn" telegraphs (render blinks, no collision), "fire" kills.
 */
export function laserState(
  state: SimState,
  pipe: Pipe
): "off" | "warn" | "fire" {
  const c = state.map.combat;
  if (!c || pipe.laserOffset === null) return "off";
  const phase = (state.frame + pipe.laserOffset) % c.laserPeriod;
  if (phase < c.laserWarn) return "warn";
  if (phase < c.laserWarn + c.laserFire) return "fire";
  return "off";
}

/**
 * Advance one 60Hz frame. `flap` is whether a flap fires on this frame;
 * `shoot` is whether the trigger is pulled (combat maps only — the gun
 * itself enforces its cooldown). Mutates and returns the state. No-op once
 * dead.
 */
export function step(state: SimState, flap: boolean, shoot = false): SimState {
  if (state.dead) return state;
  // post-revive grace ticks down; while it's up, every death check below is
  // skipped so the respawned bird can clear the hazard it hit
  if (state.invuln > 0) state.invuln -= 1;
  const m = state.map;

  if (flap) {
    state.velY = m.flapImpulse;
  } else {
    state.velY = Math.min(state.velY + m.gravity, m.maxFallSpeed);
  }
  state.birdY += state.velY;

  // ceiling clamps (classic behaviour: bonking the top doesn't kill)
  if (state.birdY - BIRD_RADIUS < 0) {
    state.birdY = BIRD_RADIUS;
    state.velY = 0;
  }

  state.scrolled += m.scrollSpeed;
  state.frame += 1;

  // make sure every pipe that could matter this frame exists
  const lastRelevant = Math.ceil(
    (state.scrolled + PIPE_WIDTH + BIRD_X) / m.pipeSpacing
  );
  ensurePipes(state, lastRelevant + 2);

  if (m.combat) stepCombat(state, shoot);

  // floor
  if (state.birdY + BIRD_RADIUS >= FLOOR_Y) {
    state.birdY = FLOOR_Y - BIRD_RADIUS;
    if (state.invuln === 0) {
      state.dead = true;
      return state;
    }
    state.velY = 0; // riding the floor out the grace window instead of dying
  }

  // pipe collision — circle vs the two rects of the nearest pipes. Grace
  // frames after a revive skip the kill entirely (the loop still runs; it
  // just can't set dead).
  if (state.invuln === 0)
  for (const pipe of state.pipes) {
    const px = pipeX(state, pipe);
    if (px > BIRD_X + BIRD_RADIUS) break; // pipes are ordered; rest are ahead
    if (px + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) continue; // already passed
    const center = gapCenterAt(state, pipe);
    const gapTop = center - m.pipeGap / 2;
    const gapBottom = center + m.pipeGap / 2;
    if (
      circleRect(BIRD_X, state.birdY, BIRD_RADIUS, px, 0, PIPE_WIDTH, gapTop) ||
      circleRect(
        BIRD_X,
        state.birdY,
        BIRD_RADIUS,
        px,
        gapBottom,
        PIPE_WIDTH,
        FLOOR_Y - gapBottom
      )
    ) {
      state.dead = true;
      return state;
    }
    // a firing laser gate closes the gap itself — time the pass
    if (
      laserState(state, pipe) === "fire" &&
      circleRect(
        BIRD_X,
        state.birdY,
        BIRD_RADIUS,
        px + PIPE_WIDTH / 2 - LASER_HALF_WIDTH,
        gapTop,
        LASER_HALF_WIDTH * 2,
        gapBottom - gapTop
      )
    ) {
      state.dead = true;
      return state;
    }
  }

  // score = pipes fully behind the bird, plus shot-down target bonuses
  let score = 0;
  for (const pipe of state.pipes) {
    if (pipeX(state, pipe) + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) score += 1;
    else break;
  }
  state.score = score + state.bonus;

  return state;
}

/** First pipe index that could still touch anything on screen. */
function firstRelevantPipe(state: SimState): number {
  const i = Math.floor(
    (state.scrolled - FIRST_PIPE_X - PIPE_WIDTH) / state.map.pipeSpacing
  );
  return i > 0 ? i : 0;
}

/** Weapons, bullets, and targets for one frame (combat maps only). */
function stepCombat(state: SimState, shoot: boolean) {
  const c = state.map.combat!;
  if (state.cooldown > 0) state.cooldown -= 1;
  if (shoot && state.cooldown === 0) {
    if (c.weapon === "beam") {
      // hitscan: one sweep vaporizes every drone on the bird's line, clean
      // across the screen and straight through the pipes
      state.lastBeam = state.frame;
      state.lastBeamY = state.birdY;
      const reach = BEAM_HALF_HEIGHT + TARGET_RADIUS;
      for (let i = firstRelevantPipe(state); i < state.pipes.length; i++) {
        const t = state.pipes[i].target;
        if (!t) continue;
        const tx = t.x0 - state.scrolled;
        if (tx - TARGET_RADIUS > WIDTH) break; // targets ordered like pipes
        if (t.hit || tx < BIRD_X) continue;
        const dy = t.y - state.birdY;
        if (dy >= -reach && dy <= reach) {
          t.hit = true;
          state.bonus += c.targetBonus;
        }
      }
    } else {
      state.bullets.push({ x: BIRD_X + BIRD_RADIUS, y: state.birdY });
    }
    state.cooldown = c.cooldown;
  }

  const start = firstRelevantPipe(state);
  const alive: Bullet[] = [];
  for (const b of state.bullets) {
    b.x += BULLET_SPEED;
    if (b.x - BULLET_RADIUS > WIDTH) continue; // flew off the right edge
    let gone = false;
    for (let i = start; i < state.pipes.length; i++) {
      const pipe = state.pipes[i];
      const px = pipeX(state, pipe);
      if (px > b.x + BULLET_RADIUS) break; // pipes are ordered; rest are ahead
      // pipes block bullets — shots have to thread the gap
      if (px + PIPE_WIDTH >= b.x - BULLET_RADIUS) {
        const center = gapCenterAt(state, pipe);
        const gapTop = center - state.map.pipeGap / 2;
        const gapBottom = center + state.map.pipeGap / 2;
        if (
          circleRect(b.x, b.y, BULLET_RADIUS, px, 0, PIPE_WIDTH, gapTop) ||
          circleRect(
            b.x,
            b.y,
            BULLET_RADIUS,
            px,
            gapBottom,
            PIPE_WIDTH,
            FLOOR_Y - gapBottom
          )
        ) {
          gone = true;
          break;
        }
      }
    }
    if (!gone) {
      for (let i = start; i < state.pipes.length; i++) {
        const t = state.pipes[i].target;
        if (!t || t.hit) continue;
        const tx = t.x0 - state.scrolled;
        if (tx - TARGET_RADIUS > WIDTH) break; // targets ordered like pipes
        const dx = tx - b.x;
        const dy = t.y - b.y;
        const rr = TARGET_RADIUS + BULLET_RADIUS;
        if (dx * dx + dy * dy < rr * rr) {
          t.hit = true;
          state.bonus += c.targetBonus;
          gone = true;
          break;
        }
      }
    }
    if (!gone) alive.push(b);
  }
  state.bullets = alive;
}

function circleRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): boolean {
  if (rh <= 0) return false;
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * Bring a dead bird back: drop it to the start height, kill its velocity,
 * clear any in-flight bullets, and hand it a grace window. Continuity is
 * otherwise preserved — score, scroll, pipes and frame all carry over, so the
 * run picks up exactly where it fell. Deterministic (only the shared reset
 * constants), so a paid revive replays bit-for-bit on the server.
 */
export function revive(state: SimState): void {
  state.dead = false;
  state.birdY = BIRD_START_Y;
  state.velY = 0;
  state.bullets = [];
  state.invuln = REVIVE_INVULN_FRAMES;
}

export interface ReplayResult {
  score: number;
  frames: number;
  died: boolean;
  /** how many of the given reviveFrames actually landed on a death */
  revivesUsed: number;
}

/**
 * Server-side authoritative replay. flapFrames and shootFrames must each be
 * strictly increasing frame indices. Returns the score the sim actually
 * produces — the client's claimed score is never trusted.
 *
 * reviveFrames are the frames the player paid to come back from. A revive is
 * only honored when the sim actually dies on that exact frame, so revivesUsed
 * (how many were consumed) tells the caller whether every claimed revive was a
 * real death — a frame that never killed the bird leaves revivesUsed short and
 * exposes a tampered payload.
 */
export function replay(
  seed: number,
  flapFrames: number[],
  shootFrames: number[] = [],
  map: MapDef = MAPS.classic,
  reviveFrames: number[] = []
): ReplayResult {
  const state = createSim(seed, map);
  let fi = 0;
  let si = 0;
  let ri = 0;
  const lastFlap = flapFrames.length ? flapFrames[flapFrames.length - 1] : -1;
  const lastRevive = reviveFrames.length
    ? reviveFrames[reviveFrames.length - 1]
    : -1;
  const lastActive = Math.max(lastFlap, lastRevive);

  while (!state.dead) {
    const flap = fi < flapFrames.length && flapFrames[fi] === state.frame;
    if (flap) fi += 1;
    const shoot = si < shootFrames.length && shootFrames[si] === state.frame;
    if (shoot) si += 1;
    step(state, flap, shoot);
    // a death the player paid to undo: reset + grace, then fly on. Only the
    // NEXT unconsumed revive frame counts, and only if the bird really died
    // here — so revives can't be reordered or invented.
    if (state.dead && ri < reviveFrames.length && reviveFrames[ri] === state.frame) {
      revive(state);
      ri += 1;
    }
    // termination guarantee: once the last flap/revive is spent the bird can
    // only fall, and >10s of freefall cannot keep it alive — bail
    // defensively in case of degenerate inputs
    if (!state.dead && state.frame > lastActive + 600) {
      break;
    }
  }

  return {
    score: state.score,
    frames: state.frame,
    died: state.dead,
    revivesUsed: ri,
  };
}
