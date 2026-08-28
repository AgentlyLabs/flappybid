// Flat-color, hard-edged pixel rendering of a sim frame — no gradients, no
// curves, ink outlines on everything, matching the original game. Shared by
// the live game canvas (GameModal) and the admin ghost-replay viewer, so a
// reviewed run looks exactly like it did when it was flown.
//
// Client-only: touches computed styles and the localStorage wardrobe fit.

import {
  WIDTH,
  HEIGHT,
  BIRD_X,
  PIPE_WIDTH,
  FLOOR_Y,
  BULLET_RADIUS,
  TARGET_RADIUS,
  LASER_HALF_WIDTH,
  BEAM_HALF_HEIGHT,
} from "./constants";
import { gapCenterAt, laserState, pipeX, type SimState } from "./sim";
import type { MapTheme } from "./maps";
import { BIRD_SPRITE_H, BIRD_SPRITE_W } from "./sprite";
import { birdFrames } from "./wardrobe";
import { utcDay } from "@/lib/day";

// sky, bands and pipe colors come from the map's theme (sim.map.theme);
// ink and the ground strip stay constant so every map still reads as the
// same game
const INK = "#26221c";
const GOLD = "#f5c842"; // site --color-gold: the PH-boost counter and pops
const DIRT = "#ded895";
const DIRT_STRIPE = "#cfc271";
const GRASS = "#9ce659";
const GRASS_DARK = "#5b8a26";

// canvas needs the real (hashed) next/font family name, not the CSS var
let pixelFamily = "";
function pixelFont(px: number): string {
  if (!pixelFamily) {
    pixelFamily =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-press-start")
        .trim() || "monospace";
  }
  return `${px}px ${pixelFamily}`;
}

// ink border drawn as four filled bars so edges stay crisp
function outlineRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t = 3
) {
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, w, t);
  ctx.fillRect(x, y + h - t, w, t);
  ctx.fillRect(x, y, t, h);
  ctx.fillRect(x + w - t, y, t, h);
}

export interface DrawOpts {
  /** wall-clock ms — drives the wing-flicker animation */
  now: number;
  /** draw the big score counter */
  showScore?: boolean;
  /** bob the bird gently (ready screen), seconds spent idle */
  bobTime?: number;
  /** PH vote boost — DISPLAY ONLY: the counter shows sim.score × boost, the
   *  sim itself never sees it (replay verification is on the raw score) */
  boost?: number;
  /** wall-clock ms of the last score gain — drives the gold pop */
  scoreBumpAt?: number;
  /** points gained at scoreBumpAt, pre-boost */
  scoreBumpGain?: number;
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  sim: SimState,
  { now, showScore = false, bobTime, boost, scoreBumpAt, scoreBumpGain }: DrawOpts
) {
  ctx.imageSmoothingEnabled = false;
  const theme = sim.map.theme;

  // sky
  ctx.fillStyle = theme.sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // high clouds — blocky steps, slow parallax
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  for (let i = 0; i < 5; i++) {
    const cx = ((i * 197 - sim.scrolled * 0.3) % (WIDTH + 160)) + 80;
    const x = Math.round(cx < 0 ? cx + WIDTH + 160 : cx) - 80;
    const y = 70 + ((i * 83) % 160);
    ctx.fillRect(x, y, 64, 14);
    ctx.fillRect(x + 10, y - 10, 28, 10);
    ctx.fillRect(x + 44, y - 6, 14, 6);
  }

  // skyline bands above the ground: pale cloud row, then bushes
  const cloudTop = FLOOR_Y - 48;
  const bushTop = FLOOR_Y - 26;
  ctx.fillStyle = theme.cloudBand;
  ctx.fillRect(0, cloudTop, WIDTH, FLOOR_Y - cloudTop);
  const cloudOff = Math.round(sim.scrolled * 0.25) % 56;
  for (let x = -cloudOff; x < WIDTH; x += 56) {
    ctx.fillRect(x, cloudTop - 12, 36, 12);
  }
  ctx.fillStyle = theme.bushBand;
  ctx.fillRect(0, bushTop, WIDTH, FLOOR_Y - bushTop);
  const bushOff = Math.round(sim.scrolled * 0.5) % 48;
  for (let x = -bushOff; x < WIDTH; x += 48) {
    ctx.fillRect(x, bushTop - 12, 30, 12);
  }

  // pipes (their gap centers can move frame to frame on swaying maps)
  for (const pipe of sim.pipes) {
    const px = Math.round(pipeX(sim, pipe));
    if (px > WIDTH || px + PIPE_WIDTH < 0) continue;
    const center = gapCenterAt(sim, pipe);
    const gapTop = Math.round(center - sim.map.pipeGap / 2);
    const gapBottom = Math.round(center + sim.map.pipeGap / 2);
    drawPipe(ctx, theme, px, 0, gapTop, true);
    drawPipe(ctx, theme, px, gapBottom, FLOOR_Y - gapBottom, false);
    if (pipe.laserOffset !== null) {
      drawLaserGate(ctx, sim, px, gapTop, gapBottom, laserState(sim, pipe));
    }
  }

  // combat layer: drones to shoot, bullets in flight, the mega-laser
  if (sim.map.combat) {
    for (const pipe of sim.pipes) {
      const t = pipe.target;
      if (!t || t.hit) continue;
      const tx = Math.round(t.x0 - sim.scrolled);
      if (tx - TARGET_RADIUS > WIDTH || tx + TARGET_RADIUS < 0) continue;
      drawDrone(ctx, tx, Math.round(t.y), sim.frame);
    }
    // beam afterglow: full blast for 4 frames, thinning tail for 4 more
    const beamAge = sim.frame - sim.lastBeam;
    if (sim.map.combat.weapon === "beam" && beamAge >= 0 && beamAge < 8) {
      const by = Math.round(sim.lastBeamY);
      const half = beamAge < 4 ? BEAM_HALF_HEIGHT : BEAM_HALF_HEIGHT / 2;
      ctx.fillStyle = "#7de291";
      ctx.fillRect(BIRD_X + 16, by - half, WIDTH - BIRD_X - 16, half * 2);
      ctx.fillStyle = "#fff";
      ctx.fillRect(BIRD_X + 16, by - 4, WIDTH - BIRD_X - 16, 8);
    }
    for (const b of sim.bullets) {
      ctx.fillStyle = INK;
      ctx.fillRect(
        Math.round(b.x) - BULLET_RADIUS - 1,
        Math.round(b.y) - BULLET_RADIUS - 1,
        BULLET_RADIUS * 2 + 2,
        BULLET_RADIUS * 2 + 2
      );
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(
        Math.round(b.x) - BULLET_RADIUS,
        Math.round(b.y) - BULLET_RADIUS,
        BULLET_RADIUS * 2,
        BULLET_RADIUS * 2
      );
    }
  }

  // ground: ink line, grass strip, striped dirt
  ctx.fillStyle = DIRT;
  ctx.fillRect(0, FLOOR_Y, WIDTH, HEIGHT - FLOOR_Y);
  ctx.fillStyle = DIRT_STRIPE;
  const stripeW = 16;
  const offset = -(Math.round(sim.scrolled) % (stripeW * 2));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, FLOOR_Y + 16, WIDTH, HEIGHT - FLOOR_Y - 16);
  ctx.clip();
  ctx.transform(1, 0, -1, 1, 0, 0);
  for (let x = offset; x < WIDTH + HEIGHT; x += stripeW * 2) {
    ctx.fillRect(x + FLOOR_Y, FLOOR_Y + 16, stripeW, HEIGHT - FLOOR_Y);
  }
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.fillRect(0, FLOOR_Y, WIDTH, 3);
  ctx.fillStyle = GRASS;
  ctx.fillRect(0, FLOOR_Y + 3, WIDTH, 9);
  ctx.fillStyle = GRASS_DARK;
  ctx.fillRect(0, FLOOR_Y + 12, WIDTH, 4);

  // bird (bobs gently on the ready screen)
  const bobbing =
    bobTime !== undefined ? Math.round(Math.sin(bobTime * 3.2) * 6) : 0;
  drawBird(ctx, BIRD_X, sim.birdY + bobbing, sim.velY, sim.dead, now);

  // the weapon rides level on the bird's chest (combat maps); flash on fire
  if (sim.map.combat && !sim.dead) {
    const c = sim.map.combat;
    const gy = Math.round(sim.birdY + bobbing) + 2;
    if (c.weapon === "beam") {
      // chunkier cannon, and a blinking charge lamp when it's ready
      ctx.fillStyle = INK;
      ctx.fillRect(BIRD_X + 4, gy - 5, 24, 12);
      ctx.fillStyle = "#3fae5a";
      ctx.fillRect(BIRD_X + 6, gy - 3, 20, 8);
      ctx.fillStyle = sim.cooldown === 0 ? "#7de291" : "#256e38";
      if (sim.cooldown > 0 || ((sim.frame >> 3) & 1) === 0) {
        ctx.fillRect(BIRD_X + 20, gy - 1, 6, 4);
      }
    } else {
      ctx.fillStyle = INK;
      ctx.fillRect(BIRD_X + 6, gy - 3, 18, 8);
      ctx.fillStyle = "#8d8d99";
      ctx.fillRect(BIRD_X + 8, gy - 1, 14, 4);
    }
    if (sim.cooldown === c.cooldown) {
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(BIRD_X + 26, gy - 4, 6, 10);
      ctx.fillStyle = "#fff";
      ctx.fillRect(BIRD_X + 28, gy - 2, 4, 6);
    }
  }

  // score — shown at ×boost when the PH vote boost is live (display only;
  // the sim score stays raw)
  if (showScore) {
    const mult = boost && boost > 1 ? boost : 1;
    ctx.font = pixelFont(40);
    ctx.textAlign = "center";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.fillStyle = mult > 1 ? GOLD : "#fff";
    ctx.strokeText(String(sim.score * mult), WIDTH / 2, 96);
    ctx.fillText(String(sim.score * mult), WIDTH / 2, 96);

    if (mult > 1) {
      ctx.font = pixelFont(14);
      ctx.lineWidth = 4;
      ctx.fillStyle = GOLD;
      ctx.strokeText(`▲ ${mult}x`, WIDTH / 2, 118);
      ctx.fillText(`▲ ${mult}x`, WIDTH / 2, 118);

      // gold pop after every gained point: "+2" climbs away from the
      // counter in chunky steps, fading like the rest of the pixel art
      if (scoreBumpAt !== undefined && scoreBumpGain) {
        const step = Math.floor((now - scoreBumpAt) / 90); // ~0.72s over 8 frames
        if (step >= 0 && step < 8) {
          ctx.font = pixelFont(22);
          ctx.lineWidth = 5;
          ctx.globalAlpha = 1 - step / 8;
          ctx.strokeText(`+${scoreBumpGain * mult}`, WIDTH / 2 + 78, 90 - step * 7);
          ctx.fillText(`+${scoreBumpGain * mult}`, WIDTH / 2 + 78, 90 - step * 7);
          ctx.globalAlpha = 1;
        }
      }
    }
  }
}

function drawPipe(
  ctx: CanvasRenderingContext2D,
  theme: MapTheme,
  x: number,
  y: number,
  h: number,
  isTop: boolean
) {
  if (h <= 0) return;
  // shaft
  ctx.fillStyle = theme.pipeBody;
  ctx.fillRect(x, y, PIPE_WIDTH, h);
  ctx.fillStyle = theme.pipeLight;
  ctx.fillRect(x + 8, y, 12, h);
  ctx.fillStyle = theme.pipeDark;
  ctx.fillRect(x + PIPE_WIDTH - 14, y, 10, h);
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, 3, h);
  ctx.fillRect(x + PIPE_WIDTH - 3, y, 3, h);

  // rim
  const rimH = 26;
  const rimY = isTop ? y + h - rimH : y;
  const rimX = x - 4;
  const rimW = PIPE_WIDTH + 8;
  ctx.fillStyle = theme.pipeBody;
  ctx.fillRect(rimX, rimY, rimW, rimH);
  ctx.fillStyle = theme.pipeLight;
  ctx.fillRect(rimX + 6, rimY + 3, 12, rimH - 6);
  ctx.fillStyle = theme.pipeDark;
  ctx.fillRect(rimX + rimW - 14, rimY + 3, 11, rimH - 6);
  outlineRect(ctx, rimX, rimY, rimW, rimH);
}

// Laser gate across a pipe's gap: emitter studs on both lips, a blinking
// thread while it charges, a solid beam while it fires.
function drawLaserGate(
  ctx: CanvasRenderingContext2D,
  sim: SimState,
  px: number,
  gapTop: number,
  gapBottom: number,
  state: "off" | "warn" | "fire"
) {
  const cx = px + PIPE_WIDTH / 2;
  ctx.fillStyle = INK;
  ctx.fillRect(cx - 7, gapTop, 14, 8);
  ctx.fillRect(cx - 7, gapBottom - 8, 14, 8);
  ctx.fillStyle = state === "off" ? "#7a2f26" : "#ff4b33";
  ctx.fillRect(cx - 4, gapTop + 2, 8, 4);
  ctx.fillRect(cx - 4, gapBottom - 6, 8, 4);

  if (state === "warn" && (sim.frame >> 2) % 2 === 0) {
    ctx.fillStyle = "rgba(255,75,51,0.55)";
    ctx.fillRect(cx - 1, gapTop + 8, 2, gapBottom - gapTop - 16);
  }
  if (state === "fire") {
    ctx.fillStyle = "#ff4b33";
    ctx.fillRect(
      cx - LASER_HALF_WIDTH - 1,
      gapTop,
      LASER_HALF_WIDTH * 2 + 2,
      gapBottom - gapTop
    );
    ctx.fillStyle = "#fff";
    ctx.fillRect(cx - 1, gapTop, 2, gapBottom - gapTop);
  }
}

// Shootable drone: rotor bar over a gold pixel body with a blinking eye.
function drawDrone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number
) {
  // slight deterministic hover so it reads as airborne, rendering-only
  const hover = ((frame >> 4) & 1) === 0 ? 0 : 2;
  const top = y - 8 + hover;
  ctx.fillStyle = INK;
  ctx.fillRect(x - 14, top - 6, 28, 4); // rotor
  ctx.fillRect(x - 2, top - 4, 4, 4); // mast
  ctx.fillRect(x - 11, top, 22, 16); // body outline
  ctx.fillStyle = "#ffd23f";
  ctx.fillRect(x - 9, top + 2, 18, 12);
  ctx.fillStyle = "#c9932a";
  ctx.fillRect(x - 9, top + 10, 18, 4);
  ctx.fillStyle = ((frame >> 3) & 1) === 0 ? "#ff4b33" : "#7a2f26";
  ctx.fillRect(x + 1, top + 4, 5, 5); // eye
}

const BIRD_SCALE = 2.4;

// The visitor's wardrobe fit (or today's cosmetic when none is saved),
// flickering between its two animation frames; wardrobe.ts caches the
// composition per day/fit.
function currentBird(now: number) {
  return birdFrames(utcDay())[Math.floor(now / 125) % 2];
}

function drawBird(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  velY: number,
  dead: boolean,
  now: number
) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  const tilt = dead ? Math.PI / 2 : Math.max(-0.5, Math.min(1.1, velY * 0.08));
  ctx.rotate(tilt);

  const bird = currentBird(now);
  const s = BIRD_SCALE;
  // anchor on the base sprite's center so the cosmetic never shifts the
  // hitbox-relative position — collision stays exactly the classic bird
  const ox = -(bird.baseCol + BIRD_SPRITE_W / 2) * s;
  const oy = -(bird.baseRow + BIRD_SPRITE_H / 2) * s;
  for (let row = 0; row < bird.rows.length; row++) {
    const line = bird.rows[row];
    for (let col = 0; col < line.length; col++) {
      const fill = bird.palette[line[col]];
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(ox + col * s, oy + row * s, s + 0.5, s + 0.5);
    }
  }

  ctx.restore();
}
