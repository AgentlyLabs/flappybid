// The live arena scene: two big birds beak to beak on the sand, hit
// splats, swing timers and the countdown. Controls live in the DOM
// (ArenaModal); this draws only the fight. Client-only.

import { WIDTH, HEIGHT } from "./constants";
import {
  ARENA_HP,
  WEAPONS,
  type ArenaSnapshot,
  type ArenaEvent,
} from "./arena";
import { BIRD_SPRITE, BIRD_PALETTE, BIRD_SPRITE_W, BIRD_SPRITE_H } from "./sprite";
import { drawWeapon, SWING_MS, specTheme } from "./weaponFx";

const INK = "#26221c";
const GOLD = "#f5c842";
const SKY = "#e9dfc2";
const SAND = "#ded895";
const SAND_DARK = "#cfc271";
const RED = "#e6533c";
const BLUE = "#5aa9e6";
const PAPER = "#fffdf2";

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

const GOLD_PALETTE = BIRD_PALETTE;
const BLUE_PALETTE: Record<string, string> = {
  ...BIRD_PALETTE,
  Y: BLUE,
  C: "#a8d4f2",
};

const SCALE = 4;
export const BIRD_POS: [{ x: number; y: number }, { x: number; y: number }] = [
  { x: 168, y: 356 },
  { x: 312, y: 356 },
];
/** the clickable body of a bird, for "click your opponent to fight" */
export function birdHitbox(i: 0 | 1) {
  const p = BIRD_POS[i];
  return { x: p.x - 36, y: p.y - 30, w: 72, h: 60 };
}

function drawBird(
  ctx: CanvasRenderingContext2D,
  i: 0 | 1,
  mine: boolean,
  thrust: number, // 0..1, lunge toward the opponent on a swing
  dead: boolean,
  now: number
) {
  const { x, y } = BIRD_POS[i];
  const facing = i === 0 ? 1 : -1;
  ctx.save();
  ctx.translate(
    x + facing * thrust * 30,
    y + ((now >> 8) & 1 && !dead ? -2 : 0)
  );
  ctx.scale(facing, 1);
  if (dead) ctx.rotate(Math.PI / 2);
  else if (thrust > 0) ctx.rotate(0.22 * thrust);
  const palette = mine ? GOLD_PALETTE : BLUE_PALETTE;
  const ox = (-BIRD_SPRITE_W / 2) * SCALE;
  const oy = (-BIRD_SPRITE_H / 2) * SCALE;
  for (let row = 0; row < BIRD_SPRITE.length; row++) {
    const line = BIRD_SPRITE[row];
    for (let col = 0; col < line.length; col++) {
      const fill = palette[line[col]];
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(ox + col * SCALE, oy + row * SCALE, SCALE + 0.5, SCALE + 0.5);
    }
  }
  ctx.restore();
}

export interface SplatAnim extends ArenaEvent {
  at: number; // performance.now() when it landed
  /** weaponFx key the attacker held — picks the spec's signature impact */
  weapon?: string;
}

function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c: string
) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

/** the special attack winds up: energy sparks orbit the bird, motes rise
 *  off its back and the ground ring pulses — in the held weapon's own
 *  spec colors. pure hype, render-only */
function drawSpecAura(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  now: number,
  key: string
) {
  const th = specTheme(key);
  // ground ring, pulsing under the claws
  const pulse = 1 + Math.sin(now / 55) * 0.15;
  const rw = 52 * pulse;
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = th.a;
  ctx.fillRect(x - rw, y + 34, rw * 2, 4);
  ctx.fillStyle = th.b;
  ctx.fillRect(x - rw * 0.7, y + 39, rw * 1.4, 3);
  ctx.globalAlpha = 1;
  // sparks orbiting the body
  const COLORS = [th.b, th.a, PAPER];
  for (let k = 0; k < 7; k++) {
    const a = now / 120 + (k * Math.PI * 2) / 7;
    const rx = 44 + Math.sin(now / 90 + k) * 6;
    const sx = x + Math.cos(a) * rx;
    const sy = y + Math.sin(a) * 30 - 4;
    const sz = 3 + ((k + (now >> 6)) % 3);
    ctx.fillStyle = COLORS[k % COLORS.length];
    ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
  }
  // motes rising off the back
  for (let k = 0; k < 4; k++) {
    const ph = (now / 6 + k * 37) % 90;
    ctx.globalAlpha = 1 - ph / 90;
    ctx.fillStyle = k % 2 ? th.b : th.a;
    ctx.fillRect(x - 20 + k * 13, y - 30 - ph * 0.6, 3, 3);
    ctx.globalAlpha = 1;
  }
}

/** every spec lands its own signature — drawn at the victim (x, y), aged
 *  in ms. `dir` is +1 when the blow travels rightward (attacker on the
 *  left), so drains stream home and slashes sweep the way they were swung */
function drawSpecImpact(
  ctx: CanvasRenderingContext2D,
  key: string,
  x: number,
  y: number,
  age: number,
  dir: number
) {
  const th = specTheme(key);
  switch (key) {
    case "whip": {
      // energy drain: the ring collapses INTO the bird, and the stolen
      // energy streams back down the lash to whoever swung it
      if (age >= 500) break;
      const pr = age / 500;
      ctx.globalAlpha = 0.9 * (1 - pr);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - pr * 1.4;
        const r = 8 + (1 - pr) * 80;
        px(ctx, x + Math.cos(a) * r - 2, y - 6 + Math.sin(a) * r * 0.7 - 2, 4, 4, k % 2 ? th.a : th.b);
      }
      for (let k = 0; k < 6; k++) {
        const t = (pr * 1.6 + k * 0.17) % 1;
        ctx.globalAlpha = 0.9 * (1 - pr) * (1 - t * 0.5);
        px(ctx, x - dir * t * 120 - 2, y - 12 - Math.sin(t * Math.PI) * 24 - 2, 4, 4, th.a);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "dds": {
      // puncture: the famous one-two — a venom slash each way, then the
      // poison beads off the wounds
      if (age >= 460) break;
      for (const c of [
        { t0: 0, sx: -1 },
        { t0: 140, sx: 1 },
      ]) {
        const la = age - c.t0;
        if (la < 0 || la > 220) continue;
        const lp = la / 220;
        ctx.globalAlpha = lp < 0.35 ? 1 : 1 - (lp - 0.35) / 0.65;
        for (let k = 0; k < 8; k++) {
          const t = k / 7;
          px(ctx, x + c.sx * (26 - t * 52) - 2, y - 30 + t * 52 - 2, 5, 5, k % 2 ? th.a : th.b);
        }
      }
      if (age > 160) {
        const dp = (age - 160) / 300;
        ctx.globalAlpha = 1 - dp;
        for (let k = 0; k < 4; k++) {
          px(ctx, x - 18 + k * 12 - 1, y + dp * 34 + (k % 2) * 8 - 1, 3, 3, th.a);
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "scim": {
      // sever: one crescent wave sweeps clean through the bird
      if (age >= 420) break;
      const pr = age / 420;
      const sweep = -Math.PI * 0.75 + pr * Math.PI * 1.5;
      ctx.globalAlpha = 0.95 * (1 - pr * pr);
      for (let k = 0; k < 7; k++) {
        const a = sweep - k * 0.16;
        const r = 34 + k * 1.5;
        const sz = 6 - k * 0.5;
        px(
          ctx,
          x + dir * Math.cos(a) * r - sz / 2,
          y - 4 + Math.sin(a) * r - sz / 2,
          sz,
          sz,
          k < 2 ? PAPER : k % 2 ? th.a : th.b
        );
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "ags": {
      // judgement: a pillar of gold light falls from above the parapet,
      // shedding feathers of light as it fades
      if (age >= 360) break;
      const pr = age / 360;
      const drop = Math.min(1, age / 90);
      const top = 96;
      ctx.globalAlpha = 0.75 * (1 - pr);
      px(ctx, x - 13, top, 26, (y + 26 - top) * drop, th.a);
      px(ctx, x - 5, top, 10, (y + 26 - top) * drop, th.b);
      if (age > 80) {
        for (let k = 0; k < 6; k++) {
          const t = ((age - 80) / 280 + k * 0.13) % 1;
          ctx.globalAlpha = 0.9 * (1 - pr) * (1 - t);
          px(
            ctx,
            x + (k % 2 ? 18 : -20) + Math.sin(t * 6 + k) * 4,
            y - 40 * t - k * 6,
            4,
            4,
            k % 2 ? th.a : th.b
          );
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "gmaul": {
      // the slam: rock chips on parabolas, dust rolling out along the
      // sand, and the floor cracks under the blow
      if (age >= 520) break;
      const pr = age / 520;
      ctx.globalAlpha = 1 - pr;
      for (let k = 0; k < 6; k++) {
        const vx = (k - 2.5) * 14;
        const ry = y + 26 - Math.sin(Math.min(1, pr * 1.2) * Math.PI) * (26 + (k % 3) * 12);
        px(ctx, x + vx * pr * 2.2 - 3, ry - 3, 6, 6, k % 2 ? th.a : th.b);
      }
      const t = Math.min(1, pr * 1.4);
      for (let k = 0; k < 4; k++) {
        px(ctx, x - (30 + t * 60 + k * 10), y + 40 - (k % 2) * 5, 6, 5, th.b);
        px(ctx, x + (24 + t * 60 + k * 10), y + 40 - (k % 2) * 5, 6, 5, th.b);
      }
      ctx.globalAlpha = (1 - pr) * 0.8;
      px(ctx, x - 34, y + 44, 26, 3, INK);
      px(ctx, x + 10, y + 47, 30, 3, INK);
      px(ctx, x - 8, y + 50, 18, 3, INK);
      ctx.globalAlpha = 1;
      break;
    }
    case "elder": {
      // the quake: two banded rings roll out slow — ember and dark iron,
      // like the head that swung — while embers drift off the blow
      if (age >= 560) break;
      const pr = age / 560;
      for (const [lag, mul] of [
        [0, 1],
        [120, 0.7],
      ] as const) {
        const la = age - lag;
        if (la < 0) continue;
        const rp = la / 440;
        if (rp > 1) continue;
        const r = (14 + rp * 100) * mul;
        ctx.globalAlpha = 0.9 * (1 - rp);
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2 + rp * 0.4;
          px(ctx, x + Math.cos(a) * r - 3, y - 6 + Math.sin(a) * r * 0.7 - 3, 6, 6, k % 2 ? th.a : th.b);
        }
      }
      for (let k = 0; k < 5; k++) {
        const t = (pr + k * 0.2) % 1;
        ctx.globalAlpha = 1 - t;
        px(ctx, x - 24 + k * 12 + Math.sin(t * 5 + k) * 5 - 1, y - t * 60 - 1, 3 + (k % 2), 3 + (k % 2), k % 2 ? th.a : GOLD);
      }
      ctx.globalAlpha = 1;
      break;
    }
    default: {
      // unknown key (old snapshot): the classic shockwave ring
      if (age >= 480) break;
      const pr = age / 480;
      const r = 16 + pr * 96;
      ctx.globalAlpha = 0.9 * (1 - pr);
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + pr * 0.6;
        const sz = 6 - pr * 3;
        px(
          ctx,
          x + Math.cos(a) * r - sz / 2,
          y - 6 + Math.sin(a) * r * 0.7 - sz / 2,
          sz,
          sz,
          k % 3 === 0 ? PAPER : k % 3 === 1 ? th.b : th.a
        );
      }
      ctx.globalAlpha = 1;
    }
  }
}

export interface SwingAnim {
  actor: number;
  at: number;
  /** STYLE_WEAPONS key held when the swing landed ("whip", "dds", …) */
  weapon: string;
  kind: ArenaEvent["kind"];
}

export interface ArenaDrawOpts {
  now: number;
  swings: SwingAnim[];
  /** you clicked the opponent — kill the prompt before the tick confirms */
  clickedEngage: boolean;
  snap: ArenaSnapshot | null;
  names: [string, string];
  youAre: 0 | 1;
  countdown: number | null; // 3..1, 0 = FIGHT!, null = not counting
  splats: SplatAnim[];
  banner?: string | null;
  subBanner?: string | null;
  tickMs: number;
  lastTickAt: number;
}

// ---- the Duel Arena itself --------------------------------------------
// Sandstone walls in coursed blocks, the barred gate you walked in
// through, brazier-topped pillars and a crowd bobbing behind the parapet
// — the pit drawn after its OSRS namesake. Render-only.

const SANDSTONE = "#d3bd82";
const SANDSTONE_D = "#bfa76a";
const SANDSTONE_L = "#e6d49e";
const ARCH_DARK = "#4a3c2a";
const EMBER = "#d97b2f";
const CROWD = ["#8a5f3c", "#6b4a2d", "#a87950", "#5a4a6e", "#3c5a44", "#7a3c58"];

function drawFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  now: number
) {
  const h = 12 + Math.sin(now / 90 + x) * 3;
  ctx.fillStyle = EMBER;
  ctx.fillRect(x - 4, y - h, 8, h);
  ctx.fillStyle = GOLD;
  ctx.fillRect(x - 2, y - h + 3, 4, h - 5);
  ctx.fillStyle = PAPER;
  ctx.fillRect(x - 1, y - 4, 2, 3);
}

function drawBackdrop(ctx: CanvasRenderingContext2D, now: number) {
  // desert sky
  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // the crowd, bobbing behind the parapet of the spectator stand
  for (let i = 0; i < 20; i++) {
    const cx = 8 + i * 24;
    const bob = Math.sin(now / 260 + i * 1.7) * 2;
    ctx.fillStyle = CROWD[i % CROWD.length];
    ctx.fillRect(cx, 76 + bob, 9, 9);
  }
  // crenellated parapet
  ctx.fillStyle = SANDSTONE;
  for (let x = 4; x < WIDTH; x += 32) ctx.fillRect(x, 84, 18, 8);
  ctx.fillStyle = SANDSTONE_D;
  ctx.fillRect(0, 90, WIDTH, 28);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 115, WIDTH, 3);

  // the sandstone wall, coursed like the real pit
  ctx.fillStyle = SANDSTONE;
  ctx.fillRect(0, 118, WIDTH, 282);
  ctx.fillStyle = SANDSTONE_D;
  for (let row = 0; row < 10; row++) {
    const y = 118 + row * 28;
    ctx.fillRect(0, y + 26, WIDTH, 2);
    for (let x = (row % 2) * 24; x < WIDTH; x += 48) {
      ctx.fillRect(x, y, 2, 26);
    }
  }

  // the arched gate, portcullis down — no one leaves mid-duel
  const gx = WIDTH / 2;
  ctx.fillStyle = ARCH_DARK;
  ctx.fillRect(gx - 40, 250, 80, 150);
  ctx.fillRect(gx - 32, 236, 64, 14);
  ctx.fillRect(gx - 22, 226, 44, 10);
  ctx.fillStyle = INK;
  for (let x = gx - 34; x <= gx + 30; x += 12) ctx.fillRect(x, 240, 4, 160);
  ctx.fillRect(gx - 48, 244, 8, 156); // jambs
  ctx.fillRect(gx + 40, 244, 8, 156);
  ctx.fillStyle = SANDSTONE_L; // keystone
  ctx.fillRect(gx - 8, 216, 16, 10);

  // flanking pillars, braziers lit
  for (const px of [gx - 150, gx + 150]) {
    ctx.fillStyle = SANDSTONE_L;
    ctx.fillRect(px - 12, 180, 24, 220);
    ctx.fillStyle = SANDSTONE_D;
    ctx.fillRect(px + 6, 180, 6, 220);
    ctx.fillStyle = INK;
    ctx.fillRect(px - 16, 172, 32, 8); // capital
    ctx.fillRect(px - 9, 162, 18, 10); // brazier bowl
    drawFlame(ctx, px, 162, now);
  }

  // the sand floor
  ctx.fillStyle = SAND;
  ctx.fillRect(0, 400, WIDTH, HEIGHT - 400);
  ctx.fillStyle = SAND_DARK;
  for (let x = 0; x < WIDTH; x += 26) ctx.fillRect(x, 414, 13, 7);
  for (let x = 13; x < WIDTH; x += 52) ctx.fillRect(x, 470, 10, 6);
  for (let x = 30; x < WIDTH; x += 44) ctx.fillRect(x, 530, 12, 6);
  for (let x = 6; x < WIDTH; x += 60) ctx.fillRect(x, 590, 9, 6);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 400, WIDTH, 3);
}

export function drawArena(ctx: CanvasRenderingContext2D, o: ArenaDrawOpts) {
  ctx.imageSmoothingEnabled = false;
  const { snap, youAre } = o;

  // a landed spec rocks the whole pit — the camera jolts, decaying fast,
  // and the mauls hit the ground a class harder than the blades
  let shX = 0;
  let shY = 0;
  for (const s of o.splats) {
    if (s.kind !== "spec-hit") continue;
    const age = o.now - s.at;
    if (age >= 0 && age < 420) {
      const f = 1 - age / 420;
      const w = specTheme(s.weapon ?? "").shake;
      shX += Math.sin(age / 16) * 8 * f * f * w;
      shY += Math.cos(age / 11) * 5 * f * f * w;
    }
  }
  ctx.save();
  if (shX || shY) {
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.translate(Math.round(shX), Math.round(shY));
  }

  drawBackdrop(ctx, o.now);

  const flip = youAre === 1; // you always stand on the left of your screen
  const seat = (i: number): 0 | 1 => (flip ? (1 - i) as 0 | 1 : (i as 0 | 1));

  if (snap) {
    for (let i = 0; i < 2; i++) {
      const f = snap.fighters[i];
      const s = seat(i);
      // lunge eases out over 350ms after this fighter's swing landed —
      // spec swings throw the whole body in, harder and longer
      let thrust = 0;
      for (const sw of o.swings) {
        if (sw.actor !== i) continue;
        const isSpec = sw.kind === "spec-hit" || sw.kind === "spec-miss";
        const dur = isSpec ? 480 : 350;
        const age = o.now - sw.at;
        if (age < dur) {
          thrust = Math.max(thrust, (1 - age / dur) * (isSpec ? 1.6 : 1));
        }
      }
      drawBird(ctx, s, i === youAre, thrust, snap.over && f.hp === 0, o.now);

      // weapon in claw, swinging its OSRS-style arc (weaponFx owns the
      // per-weapon motion; the swing list carries what was held and when)
      {
        const p = BIRD_POS[s];
        const dir = s === 0 ? 1 : -1;
        const held = WEAPONS[f.weapon]?.key ?? "scim";
        let u = -1;
        let swingKey: string = held;
        let spec = false;
        for (const sw of o.swings) {
          if (sw.actor !== i) continue;
          const prog = (o.now - sw.at) / (SWING_MS[sw.weapon] ?? 350);
          if (prog >= 0 && prog < 1) {
            u = prog;
            swingKey = sw.weapon;
            spec = sw.kind === "spec-hit" || sw.kind === "spec-miss";
          }
        }
        if (!(snap.over && f.hp === 0)) {
          // the spec's power-up aura wraps the whole bird for the swing,
          // dressed in the swinging weapon's colors
          if (spec && u >= 0) {
            drawSpecAura(ctx, p.x + dir * thrust * 30, p.y, o.now, swingKey);
          }
          ctx.save();
          ctx.translate(
            p.x + dir * thrust * 10,
            p.y + ((o.now >> 8) & 1 ? -2 : 0)
          );
          ctx.scale(dir, 1);
          drawWeapon(ctx, swingKey, u, spec);
          ctx.restore();
        }
      }

      // top HUD: name + hp + swing pips
      const left = s === 0;
      const hx = left ? 12 : WIDTH - 12 - 170;
      ctx.font = pixelFont(11);
      ctx.textAlign = left ? "left" : "right";
      ctx.fillStyle = INK;
      ctx.fillText(o.names[i], left ? hx + 1 : WIDTH - 11, 25);
      ctx.fillStyle = i === youAre ? "#d9a428" : BLUE;
      ctx.fillText(o.names[i], left ? hx : WIDTH - 12, 24);
      outlineRect(ctx, hx, 32, 170, 18);
      ctx.fillStyle = "#b13a28";
      ctx.fillRect(hx + 3, 35, 164, 12);
      const w = Math.round((164 * f.hp) / ARENA_HP);
      ctx.fillStyle = "#9ce659";
      ctx.fillRect(left ? hx + 3 : hx + 3 + 164 - w, 35, w, 12);
      ctx.font = pixelFont(9);
      ctx.fillStyle = INK;
      ctx.fillText(String(f.hp), left ? hx + 3 : hx + 167, 62);
      // what they're holding / wearing — no mystery deaths
      ctx.font = pixelFont(7);
      ctx.fillStyle = "#75705a";
      ctx.fillText(
        WEAPONS[f.weapon]?.label ?? "",
        left ? hx + 3 : hx + 167,
        76
      );
      // swing countdown pips
      const pips = f.nextSwingIn;
      ctx.fillStyle = INK;
      for (let k = 0; k < Math.min(5, pips); k++) {
        ctx.fillRect(left ? hx + 40 + k * 12 : hx + 130 - k * 12, 54, 8, 8);
      }
    }

    // tick metronome — the fight's heartbeat
    const frac = Math.min(1, (o.now - o.lastTickAt) / o.tickMs);
    outlineRect(ctx, WIDTH / 2 - 60, 76, 120, 12, 2);
    ctx.fillStyle = GOLD;
    ctx.fillRect(WIDTH / 2 - 58, 78, Math.round(116 * frac), 8);
  }

  // splats drift up and fade
  for (const s of o.splats) {
    const age = o.now - s.at;
    if (age > 900) continue;
    const target = seat((s.kind === "eat" ? s.actor : 1 - s.actor) as 0 | 1);
    const p = BIRD_POS[target];

    // a landed spec detonates in the weapon's own signature — drain,
    // one-two, sever, judgement, slam or quake
    if (s.kind === "spec-hit") {
      const atkDir = seat(s.actor as 0 | 1) === 0 ? 1 : -1;
      drawSpecImpact(ctx, s.weapon ?? "", p.x, p.y, age, atkDir);
    }
    // a whiffed spec sputters out — sparks sag into the sand
    if (s.kind === "spec-miss" && age < 420) {
      const pr = age / 420;
      ctx.globalAlpha = 0.7 * (1 - pr);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + k;
        ctx.fillStyle = k % 2 ? "#75705a" : specTheme(s.weapon ?? "").a;
        ctx.fillRect(
          p.x + Math.cos(a) * (10 + pr * 26) - 2,
          p.y - 10 + Math.sin(a) * 8 + pr * 30 - 2,
          4,
          4
        );
      }
      ctx.globalAlpha = 1;
    }

    const specHit = s.kind === "spec-hit";
    const h = specHit ? 18 : 15; // the spec's number hits bigger too
    const y = p.y - 34 - age * 0.035;
    const x = p.x + (target === 0 ? -30 : 30);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    if (specHit) {
      // pulsing halo behind the big gold diamond, in the spec's color
      const pulse = 1 + 0.1 * Math.sin(age / 45);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = specTheme(s.weapon ?? "").a;
      ctx.fillRect(-h - 4, -h - 4, h * 2 + 8, h * 2 + 8);
    }
    ctx.fillStyle = INK;
    ctx.fillRect(-h, -h, h * 2, h * 2);
    ctx.fillStyle =
      s.kind === "eat"
        ? "#9ce659"
        : s.kind === "miss" || s.kind === "spec-miss"
          ? "#75705a"
          : specHit
            ? GOLD
            : RED;
    ctx.fillRect(-h + 3, -h + 3, h * 2 - 6, h * 2 - 6);
    ctx.restore();
    ctx.font = pixelFont(specHit ? 14 : 11);
    ctx.textAlign = "center";
    ctx.fillStyle = specHit ? INK : PAPER;
    ctx.fillText(String(s.value), x, y + (specHit ? 5 : 4));
  }

  // the impact frame washes the whole pit in the spec's color for a blink
  for (const s of o.splats) {
    if (s.kind !== "spec-hit") continue;
    const age = o.now - s.at;
    if (age < 130) {
      ctx.globalAlpha = 0.22 * (1 - age / 130);
      ctx.fillStyle = specTheme(s.weapon ?? "").wash;
      ctx.fillRect(-12, -12, WIDTH + 24, HEIGHT + 24);
      ctx.globalAlpha = 1;
    }
  }

  // countdown
  if (o.countdown !== null) {
    ctx.font = pixelFont(o.countdown === 0 ? 30 : 48);
    ctx.textAlign = "center";
    const label = o.countdown === 0 ? "FIGHT!" : String(o.countdown);
    ctx.fillStyle = INK;
    ctx.fillText(label, WIDTH / 2 + 3, 250 + 3);
    ctx.fillStyle = o.countdown === 0 ? RED : GOLD;
    ctx.fillText(label, WIDTH / 2, 250);
  }

  // end banner
  if (o.banner) {
    ctx.save();
    ctx.translate(WIDTH / 2, 230);
    ctx.rotate(-0.05);
    ctx.font = pixelFont(20);
    ctx.textAlign = "center";
    const w = ctx.measureText(o.banner).width + 44;
    ctx.fillStyle = INK;
    ctx.fillRect(-w / 2 - 4, -30, w + 8, 60);
    ctx.fillStyle = GOLD;
    ctx.fillRect(-w / 2, -26, w, 52);
    ctx.fillStyle = INK;
    ctx.fillText(o.banner, 0, 7);
    ctx.restore();
    if (o.subBanner) {
      ctx.font = pixelFont(10);
      ctx.textAlign = "center";
      ctx.fillStyle = INK;
      ctx.fillText(o.subBanner, WIDTH / 2, 292);
    }
  }

  ctx.restore(); // camera shake
}

export { WEAPONS };
