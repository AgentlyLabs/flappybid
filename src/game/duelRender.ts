// The duel pit, rendered flat and hard-edged like everything else — sand
// floor, stone cover, two birds squaring off, hit splats, protect chips,
// spec beams. Shared by the recording screen (you vs the practice dummy),
// the reveal player and the spectator player, so a fight always looks the
// way it was fought.
//
// Client-only: touches computed styles and the localStorage wardrobe fit.

import { WIDTH, HEIGHT, FLOOR_Y, BIRD_RADIUS } from "./constants";
import {
  PILLARS,
  SPEC_WARN,
  SPEC_FIRE,
  SPEC_HALF_HEIGHT,
  FOCUS_MAX,
  SPEC_MAX,
  DUEL_HP,
  SUDDEN_DEATH_HP,
  W_EGG,
  type DuelState,
  type Fighter,
} from "./duel";
import { BIRD_SPRITE, BIRD_PALETTE, BIRD_SPRITE_W, BIRD_SPRITE_H } from "./sprite";
import { birdFrames } from "./wardrobe";
import { utcDay } from "@/lib/day";

const INK = "#26221c";
const GOLD = "#f5c842";
const SKY = "#e9dfc2";
const SAND = "#ded895";
const SAND_DARK = "#cfc271";
const STONE = "#cfc271";
const RED = "#e6533c";
const BLUE = "#5aa9e6";
const PAPER = "#fffdf2";
const GRASS_DARK = "#5b8a26";
const SILVER = "#cfd2dc";

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

// the opponent flies the stock bird in team colors; your side wears your
// wardrobe fit (drawn via birdFrames, same as the course game)
const BLUE_PALETTE: Record<string, string> = {
  ...BIRD_PALETTE,
  Y: BLUE,
  C: "#a8d4f2",
};
const RED_PALETTE: Record<string, string> = {
  ...BIRD_PALETTE,
  Y: RED,
  C: "#f2938a",
};

const BIRD_SCALE = 2.4;
const WEAPON_GLYPHS = ["🗡", "🪶", "🥚"] as const;
export const WEAPON_NAMES = ["beak blade", "feather gun", "egg mortar"] as const;

function drawDuelBird(
  ctx: CanvasRenderingContext2D,
  f: Fighter,
  facing: 1 | -1,
  skin: "mine" | "red" | "blue",
  now: number
) {
  ctx.save();
  ctx.translate(Math.round(f.x), Math.round(f.y));
  ctx.scale(facing, 1);
  const dead = f.hp === 0;
  const tilt = dead
    ? Math.PI / 2
    : Math.max(-0.4, Math.min(0.7, f.velY * 0.06));
  ctx.rotate(tilt);

  if (skin === "mine") {
    const bird = birdFrames(utcDay())[Math.floor(now / 125) % 2];
    const s = BIRD_SCALE;
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
  } else {
    const palette = skin === "red" ? RED_PALETTE : BLUE_PALETTE;
    const s = BIRD_SCALE;
    const ox = (-BIRD_SPRITE_W / 2) * s;
    const oy = (-BIRD_SPRITE_H / 2) * s;
    for (let row = 0; row < BIRD_SPRITE.length; row++) {
      const line = BIRD_SPRITE[row];
      for (let col = 0; col < line.length; col++) {
        const fill = palette[line[col]];
        if (!fill) continue;
        ctx.fillStyle = fill;
        ctx.fillRect(ox + col * s, oy + row * s, s + 0.5, s + 0.5);
      }
    }
  }
  ctx.restore();
}

export interface DuelDrawOpts {
  now: number;
  names: [string, string];
  /** which fighter is "you" (wears your fit, owns the bottom HUD); -1 when
   *  spectating — both birds fly team colors */
  me: 0 | 1 | -1;
  /** banner text once the fight is over ("K.O.! SKYRAT TAKES IT") */
  banner?: string | null;
  subBanner?: string | null;
}

export function drawDuelFrame(
  ctx: CanvasRenderingContext2D,
  state: DuelState,
  opts: DuelDrawOpts
) {
  const { now, names, me } = opts;
  ctx.imageSmoothingEnabled = false;

  // -- pit
  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // sand floor
  ctx.fillStyle = SAND;
  ctx.fillRect(0, FLOOR_Y, WIDTH, HEIGHT - FLOOR_Y);
  ctx.fillStyle = SAND_DARK;
  for (let x = 0; x < WIDTH; x += 24) ctx.fillRect(x, FLOOR_Y + 10, 12, 6);
  ctx.fillStyle = INK;
  ctx.fillRect(0, FLOOR_Y, WIDTH, 3);
  // stone cover
  for (const p of PILLARS) {
    ctx.fillStyle = STONE;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(p.x + 3, p.y + 3, 4, p.h - 6);
    outlineRect(ctx, p.x, p.y, p.w, p.h);
  }

  // -- spec telegraphs and beams (behind the birds)
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const since = state.frame - f.specCast;
    if (since >= 0 && since < SPEC_WARN) {
      if ((state.frame >> 2) & 1) {
        ctx.fillStyle = "rgba(230,83,60,.35)";
        ctx.fillRect(0, f.specY - SPEC_HALF_HEIGHT, WIDTH, SPEC_HALF_HEIGHT * 2);
      }
    } else if (since >= SPEC_WARN && since < SPEC_WARN + SPEC_FIRE) {
      ctx.fillStyle = GOLD;
      ctx.fillRect(0, f.specY - SPEC_HALF_HEIGHT, WIDTH, SPEC_HALF_HEIGHT * 2);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, f.specY - 4, WIDTH, 8);
    }
  }

  // -- projectiles
  for (const p of state.projectiles) {
    if (p.kind === W_EGG) {
      ctx.fillStyle = INK;
      ctx.fillRect(p.x - 7, p.y - 9, 14, 18);
      ctx.fillStyle = PAPER;
      ctx.fillRect(p.x - 5, p.y - 7, 10, 14);
    } else {
      ctx.fillStyle = INK;
      ctx.fillRect(p.x - 6, p.y - 4, 12, 8);
      ctx.fillStyle = SILVER;
      ctx.fillRect(p.x - 4, p.y - 2, 8, 4);
    }
  }

  // -- birds (each faces its opponent)
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const opp = state.fighters[1 - i];
    const facing: 1 | -1 = opp.x >= f.x ? 1 : -1;
    const skin = me === i ? "mine" : i === 0 ? "red" : "blue";
    // lunge motion lines
    if (f.lungeLeft > 0) {
      ctx.fillStyle = "rgba(38,34,28,.3)";
      for (let t = 1; t <= 3; t++) {
        ctx.fillRect(
          f.x - f.lungeVx * t * 2 - 8,
          f.y - f.lungeVy * t * 2 - 2,
          16,
          4
        );
      }
    }
    drawDuelBird(ctx, f, facing, skin, now);
    // protect chip above the head
    if (f.protect !== 0) {
      const label = ["", "⛨🗡", "⛨🪶", "⛨🥚"][f.protect];
      ctx.font = pixelFont(10);
      ctx.textAlign = "center";
      ctx.fillStyle = INK;
      ctx.fillRect(f.x - 22, f.y - BIRD_RADIUS - 34, 44, 20);
      ctx.fillStyle = GOLD;
      ctx.fillText(label, f.x, f.y - BIRD_RADIUS - 19);
    }
  }

  // -- hit splats: red diamonds (blue-ish when blocked), fade after a beat
  for (const h of state.hits) {
    const age = state.frame - h.frame;
    if (age > 36) continue;
    const t = state.fighters[h.target];
    const x = t.x + (h.target === 0 ? -26 : 26);
    const y = t.y - 20 - age * 0.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = INK;
    ctx.fillRect(-14, -14, 28, 28);
    ctx.fillStyle = h.blocked ? BLUE : h.kind === 3 ? GOLD : RED;
    ctx.fillRect(-11, -11, 22, 22);
    ctx.restore();
    ctx.font = pixelFont(11);
    ctx.textAlign = "center";
    ctx.fillStyle = h.blocked || h.kind === 3 ? INK : PAPER;
    ctx.fillText(String(h.dmg), x, y + 4);
  }

  // -- top HUD: names + HP bars
  const maxHp = state.ruleset.suddenDeath ? SUDDEN_DEATH_HP : DUEL_HP;
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    const left = i === 0;
    const x = left ? 12 : WIDTH - 12 - 150;
    ctx.font = pixelFont(11);
    ctx.textAlign = left ? "left" : "right";
    ctx.fillStyle = INK;
    ctx.fillText(names[i], left ? x + 1 : WIDTH - 11, 25);
    ctx.fillStyle = i === 0 ? RED : BLUE;
    ctx.fillText(names[i], left ? x : WIDTH - 12, 24);
    outlineRect(ctx, x, 32, 150, 16);
    ctx.fillStyle = "#b13a28";
    ctx.fillRect(x + 3, 35, 144, 10);
    ctx.fillStyle = "#9ce659";
    const w = Math.round((144 * f.hp) / maxHp);
    ctx.fillRect(left ? x + 3 : x + 3 + 144 - w, 35, w, 10);
  }

  // -- bottom HUD for the player's side (skip while spectating)
  if (me === 0 || me === 1) {
    const f = state.fighters[me];
    const y = HEIGHT - 46;
    ctx.fillStyle = "rgba(255,253,242,.9)";
    ctx.fillRect(0, y - 12, WIDTH, HEIGHT - y + 12);
    ctx.fillStyle = INK;
    ctx.fillRect(0, y - 12, WIDTH, 3);
    // weapon slots
    for (let w = 0; w < 3; w++) {
      const sx = 12 + w * 40;
      ctx.fillStyle = f.weapon === w ? GOLD : PAPER;
      ctx.fillRect(sx, y, 34, 34);
      outlineRect(ctx, sx, y, 34, 34);
      ctx.font = pixelFont(14);
      ctx.textAlign = "center";
      ctx.fillStyle = INK;
      ctx.fillText(WEAPON_GLYPHS[w], sx + 17, y + 24);
    }
    // spec bar
    outlineRect(ctx, 140, y + 4, 120, 14);
    ctx.fillStyle = f.spec >= SPEC_MAX ? GOLD : "#d9a428";
    ctx.fillRect(143, y + 7, Math.round((114 * f.spec) / SPEC_MAX), 8);
    ctx.font = pixelFont(8);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.fillText(f.spec >= SPEC_MAX ? "SPEC READY!" : "spec", 140, y + 30);
    // focus (protect fuel)
    outlineRect(ctx, 270, y + 4, 120, 14);
    ctx.fillStyle = BLUE;
    ctx.fillRect(273, y + 7, Math.round((114 * f.focus) / FOCUS_MAX), 8);
    ctx.fillText("protect", 270, y + 30);
    // cooldown pip
    if (f.attackCd > 0 || f.switchLock > 0) {
      ctx.fillStyle = "#75705a";
      ctx.fillText("...", 400, y + 14);
    }
  }

  // -- banner
  if (opts.banner) {
    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT / 2 - 40);
    ctx.rotate(-0.05);
    ctx.font = pixelFont(24);
    ctx.textAlign = "center";
    const w = ctx.measureText(opts.banner).width + 48;
    ctx.fillStyle = INK;
    ctx.fillRect(-w / 2 - 4, -34, w + 8, 68);
    ctx.fillStyle = GOLD;
    ctx.fillRect(-w / 2, -30, w, 60);
    ctx.fillStyle = INK;
    ctx.fillText(opts.banner, 0, 8);
    ctx.restore();
    if (opts.subBanner) {
      ctx.font = pixelFont(11);
      ctx.textAlign = "center";
      ctx.fillStyle = INK;
      ctx.fillText(opts.subBanner, WIDTH / 2, HEIGHT / 2 + 34);
    }
  }

  // frame clock, small and out of the way
  ctx.font = pixelFont(9);
  ctx.textAlign = "center";
  ctx.fillStyle = GRASS_DARK;
  ctx.fillText(
    `${Math.floor(state.frame / 60)}s`,
    WIDTH / 2,
    24
  );
}
