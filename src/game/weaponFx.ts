// The armory, drawn in code: every arena weapon is a pixel sprite with a
// swing modeled on its OSRS namesake — the whip lashes forward and cracks,
// the DDS lands a quick double jab, the godsword falls from overhead, the
// mauls rear back and slam into the sand. Render-only (Math.sin & friends
// welcome here); nothing in this file touches the deterministic sim.
//
// Local space: origin at the bird's center, +x toward the opponent (the
// caller mirrors with ctx.scale), y down. The claw is at CLAW_X/CLAW_Y.

const INK = "#26221c";
const GOLD = "#f5c842";
const PAPER = "#fffdf2";
const LEATHER = "#6b4a2d";
const SILVER = "#cfd2dc";
const SILVER_HI = "#f1f3f8";
const GRANITE = "#8d8d85";
const GRANITE_D = "#6f6f68";
const D_RED = "#a83a2e";
const D_RED_HI = "#d8694a";
const POISON = "#63c74d";
const RUNE = "#4d6e8a";
const DARK_IRON = "#3c3730";
const EMBER = "#d97b2f";
const WHIP_LEATHER = "#4a4438";
const WHIP_TIP = "#86b04f";
const DUST = "#cfc271";
/** spec-energy teal, after the OSRS special attack bar */
export const SPEC_TEAL = "#37d5c8";

/** Each weapon's special wears its own colors, after its OSRS namesake —
 *  the whip drains teal, the DDS spits venom, the scim severs red, the
 *  gmaul is all granite and sand, the AGS calls down gold judgement and
 *  the elder quakes in embers. `shake` scales the camera jolt on a landed
 *  spec; the impact shapes themselves live in arenaRender. */
export interface SpecTheme {
  a: string; // lead color: aura ring, sparks, drain trails
  b: string; // second color in the pair
  wash: string; // the full-screen impact-frame tint
  shake: number;
}
export const SPEC_THEMES: Record<string, SpecTheme> = {
  whip: { a: SPEC_TEAL, b: "#7ce8dd", wash: SPEC_TEAL, shake: 0.7 },
  dds: { a: POISON, b: "#b4e88a", wash: POISON, shake: 0.9 },
  scim: { a: D_RED_HI, b: EMBER, wash: D_RED_HI, shake: 1 },
  gmaul: { a: GRANITE, b: DUST, wash: DUST, shake: 1.5 },
  ags: { a: GOLD, b: PAPER, wash: GOLD, shake: 1.2 },
  elder: { a: EMBER, b: DARK_IRON, wash: EMBER, shake: 1.6 },
};
const SPEC_FALLBACK: SpecTheme = { a: SPEC_TEAL, b: GOLD, wash: GOLD, shake: 1 };
export function specTheme(key: string): SpecTheme {
  return SPEC_THEMES[key] ?? SPEC_FALLBACK;
}

const CLAW_X = 20;
const CLAW_Y = 14;
/** the blades are authored small; the arena bird is drawn at 4x */
const ARM_SCALE = 1.8;

/** How long each weapon's swing animation runs, in ms. Heavier = slower,
 *  like the real thing — purely visual; the tick decides when hits land. */
export const SWING_MS: Record<string, number> = {
  dds: 300,
  needle: 280,
  xbow: 400,
  bow: 380,
  whip: 400,
  ags: 540,
  scim: 360,
  gmaul: 440,
  boulder: 480,
  elder: 580,
  kodai: 420,
  sang: 460,
  tstaff: 460,
};

/** orb colors per staff — arenaRender reuses these for the flying shot */
export const STAFF_ORBS: Record<string, string> = {
  kodai: "#8fd3e8",
  sang: "#c22f45",
  tstaff: POISON,
};

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const ease = (t: number) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

type Keys = ReadonlyArray<readonly [number, number]>;

/** keyframe track: [u, value] pairs, smoothstepped between neighbours */
function track(u: number, keys: Keys): number {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [u0, v0] = keys[i - 1];
      const [u1, v1] = keys[i];
      return v0 + (v1 - v0) * ease((u - u0) / (u1 - u0));
    }
  }
  return keys[keys.length - 1][1];
}

function blk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c: string
): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

/** little gold starburst — blade tips at the moment of impact */
function flash(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  blk(ctx, x - 1, y - r, 3, r * 2, GOLD);
  blk(ctx, x - r, y - 1, r * 2, 3, GOLD);
  blk(ctx, x - 1, y - 1, 3, 3, PAPER);
}

// ------------------------------------------------------------- blades --
// Each drawn along +x from the claw pivot at (0,0).

function scimBlade(ctx: CanvasRenderingContext2D): void {
  blk(ctx, -3, -2, 8, 4, GOLD); // hilt
  blk(ctx, 4, -5, 3, 10, GOLD); // guard
  // the curve, stepping up block by block
  blk(ctx, 7, -2, 8, 5, D_RED);
  blk(ctx, 14, -4, 8, 5, D_RED);
  blk(ctx, 21, -6, 7, 5, D_RED);
  blk(ctx, 27, -8, 5, 4, D_RED);
  blk(ctx, 7, -3, 7, 2, D_RED_HI);
  blk(ctx, 14, -5, 7, 2, D_RED_HI);
  blk(ctx, 21, -7, 6, 2, D_RED_HI);
}

function agsBlade(ctx: CanvasRenderingContext2D): void {
  blk(ctx, -7, -2, 8, 4, LEATHER); // grip
  blk(ctx, 1, -7, 4, 14, GOLD); // crossguard
  blk(ctx, 1, -10, 3, 3, PAPER); // armadyl wings
  blk(ctx, 1, 7, 3, 3, PAPER);
  blk(ctx, 5, -4, 28, 8, SILVER);
  blk(ctx, 33, -3, 5, 6, SILVER);
  blk(ctx, 38, -2, 4, 4, SILVER);
  blk(ctx, 5, -4, 33, 2, SILVER_HI); // edge light
  blk(ctx, 8, -1, 22, 2, GOLD); // the fuller runs gold
}

function ddsBlade(ctx: CanvasRenderingContext2D): void {
  blk(ctx, -5, -2, 7, 4, GOLD);
  blk(ctx, 2, -4, 2, 8, GOLD); // guard
  blk(ctx, 4, -2, 11, 4, D_RED);
  blk(ctx, 4, -2, 12, 1, D_RED_HI);
  blk(ctx, 15, -1, 4, 3, POISON); // envenomed tip
}

function needleBlade(ctx: CanvasRenderingContext2D): void {
  blk(ctx, -5, -2, 6, 4, LEATHER);
  blk(ctx, 1, -1, 20, 2, SILVER);
  blk(ctx, 19, -1, 4, 2, SILVER_HI);
}

function gmaulHead(ctx: CanvasRenderingContext2D): void {
  blk(ctx, 0, -2, 17, 4, LEATHER);
  blk(ctx, 16, -9, 16, 18, INK);
  blk(ctx, 18, -7, 12, 14, GRANITE);
  blk(ctx, 20, -4, 3, 3, GRANITE_D); // speckle
  blk(ctx, 25, 1, 3, 3, GRANITE_D);
  blk(ctx, 22, 4, 2, 2, GRANITE_D);
}

function boulderHead(ctx: CanvasRenderingContext2D): void {
  blk(ctx, 0, -2, 9, 4, LEATHER);
  blk(ctx, 7, -9, 18, 18, INK);
  blk(ctx, 9, -7, 14, 14, GRANITE);
  blk(ctx, 8, -4, 16, 8, GRANITE); // round the sides
  blk(ctx, 12, -4, 4, 3, GRANITE_D);
  blk(ctx, 17, 1, 3, 3, GRANITE_D);
}

function elderHead(ctx: CanvasRenderingContext2D): void {
  blk(ctx, 0, -2, 15, 4, LEATHER);
  blk(ctx, 14, -12, 26, 24, INK);
  blk(ctx, 16, -10, 22, 20, DARK_IRON);
  blk(ctx, 18, -10, 4, 20, EMBER); // banded head
  blk(ctx, 31, -10, 4, 20, EMBER);
}

// ------------------------------------------------------------- motions --

/** rotating swing around the claw: windup back, strike through, recover.
 *  Ghost trails while the blade is moving fast, a flash at impact. */
function swingRot(
  ctx: CanvasRenderingContext2D,
  u: number,
  idle: number,
  keys: Keys,
  impactU: number,
  tipLen: number,
  blade: (c: CanvasRenderingContext2D) => void,
  dust = false
): void {
  const angle = u < 0 ? idle : track(u, keys);
  if (u >= 0) {
    const vel = angle - track(Math.max(0, u - 0.05), keys);
    if (vel > 0.25) {
      // the chop is in flight — trail it
      for (const [back, alpha] of [
        [0.45, 0.28],
        [0.9, 0.13],
      ] as const) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.rotate(angle - back);
        blade(ctx);
        ctx.restore();
      }
    }
  }
  ctx.save();
  ctx.rotate(angle);
  blade(ctx);
  ctx.restore();
  if (u >= 0 && Math.abs(u - impactU) < 0.07) {
    flash(ctx, Math.cos(angle) * tipLen, Math.sin(angle) * tipLen, 6);
  }
  if (dust && u >= impactU && u <= impactU + 0.35) {
    // the slam kicks sand off the pit floor
    const p = (u - impactU) / 0.35;
    const strike = track(impactU, keys);
    const gx = Math.cos(strike) * tipLen;
    const gy = Math.sin(strike) * tipLen;
    ctx.globalAlpha = 1 - p;
    blk(ctx, gx - 6 - p * 14, gy - p * 8 - 2, 5, 5, DUST);
    blk(ctx, gx + p * 4 - 2, gy - p * 14 - 2, 5, 5, DUST);
    blk(ctx, gx + 6 + p * 12, gy - p * 9 - 2, 5, 5, DUST);
    ctx.globalAlpha = 1;
  }
}

/** straight thrust: the blade rides a jab track toward the opponent */
function jab(
  ctx: CanvasRenderingContext2D,
  u: number,
  keys: Keys,
  jabLen: number,
  blade: (c: CanvasRenderingContext2D) => void
): void {
  const d = u < 0 ? 0 : track(u, keys) * jabLen;
  ctx.save();
  ctx.translate(d, 0);
  blade(ctx);
  ctx.restore();
  if (u >= 0 && d > jabLen * 0.8) {
    // speed lines behind the thrust
    ctx.globalAlpha = 0.3;
    blk(ctx, d - 14, -3, 8, 2, INK);
    blk(ctx, d - 11, 2, 8, 2, INK);
    ctx.globalAlpha = 1;
  }
}

/** the abyssal wormwhip: handle in claw, lash as a quadratic curve that
 *  hangs at rest, then snaps forward and cracks at full extension */
function whip(ctx: CanvasRenderingContext2D, u: number): void {
  blk(ctx, -2, -2, 9, 4, WHIP_LEATHER);
  blk(ctx, -2, -2, 9, 1, "#5c554a");
  const fx = 7;
  const fy = 0;
  let tx: number;
  let ty: number;
  let curl: number;
  if (u < 0) {
    tx = 13;
    ty = 26;
    curl = 10;
  } else {
    const a = track(u, [
      [0, -2.1],
      [0.45, 0.1],
      [0.75, 0.35],
      [1, 1.1],
    ]);
    const reach = track(u, [
      [0, 18],
      [0.45, 46],
      [0.8, 40],
      [1, 26],
    ]);
    tx = fx + Math.cos(a) * reach;
    ty = fy + Math.sin(a) * reach;
    curl = track(u, [
      [0, 16],
      [0.45, 2],
      [1, 12],
    ]);
  }
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (fx + tx) / 2 - (dy / len) * curl;
  const cy = (fy + ty) / 2 + (dx / len) * curl;
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    const x = (1 - t) * (1 - t) * fx + 2 * (1 - t) * t * cx + t * t * tx;
    const y = (1 - t) * (1 - t) * fy + 2 * (1 - t) * t * cy + t * t * ty;
    blk(ctx, x - 1.5, y - 1.5, 3, 3, i > 7 ? WHIP_TIP : WHIP_LEATHER);
  }
  if (u >= 0.38 && u <= 0.56) flash(ctx, tx, ty, 5); // the crack
}

/** the rune crossbeak: recoils on the shot; the bolt itself flies in
 *  world space (arenaRender draws it — it needs the target's seat) */
function xbow(ctx: CanvasRenderingContext2D, u: number): void {
  const recoil = u < 0 ? 0 : track(u, [
    [0, 0],
    [0.08, 1],
    [0.45, 0],
    [1, 0],
  ]) * -5;
  ctx.save();
  ctx.translate(recoil, 2);
  blk(ctx, -8, -2, 20, 5, LEATHER); // stock
  blk(ctx, 2, -3, 14, 2, SILVER); // rail
  blk(ctx, 12, -10, 3, 8, RUNE); // limbs
  blk(ctx, 12, 3, 3, 8, RUNE);
  blk(ctx, 13, -11, 3, 3, SILVER);
  blk(ctx, 13, 9, 3, 3, SILVER);
  // string, drawn back to the nut
  blk(ctx, 10, -9, 2, 2, PAPER);
  blk(ctx, 7, -6, 2, 2, PAPER);
  blk(ctx, 4, -3, 2, 2, PAPER);
  blk(ctx, 10, 8, 2, 2, PAPER);
  blk(ctx, 7, 5, 2, 2, PAPER);
  blk(ctx, 4, 2, 2, 2, PAPER);
  // a bolt sits loaded except right after firing
  if (u < 0 || u > 0.6) blk(ctx, 6, -2, 14, 2, SILVER_HI);
  ctx.restore();
}

/** the twisted bowbeak: limbs held out front, string comes back to the
 *  cheek, then snaps — the arrow flies in world space (arenaRender) */
function bow(ctx: CanvasRenderingContext2D, u: number): void {
  const draw = u < 0 ? 0 : track(u, [
    [0, 0],
    [0.18, 1],
    [0.28, 0],
    [1, 0],
  ]);
  // the curved limbs, tip to tip
  blk(ctx, 10, -17, 3, 6, LEATHER);
  blk(ctx, 12, -12, 3, 9, LEATHER);
  blk(ctx, 13, -4, 3, 8, GOLD); // twisted grip
  blk(ctx, 12, 3, 3, 9, LEATHER);
  blk(ctx, 10, 11, 3, 6, LEATHER);
  // the string, pulled back with the draw
  const sx = 11 - draw * 8;
  blk(ctx, sx, -14, 1.5, 28, PAPER);
  // an arrow nocked while drawing, gone once loosed
  if (u < 0 || draw > 0.05) {
    blk(ctx, sx - 2, -1, 18, 2, SILVER_HI);
    blk(ctx, sx - 4, -2, 4, 4, D_RED); // fletching
  }
}

/** the beakstaves: shaft rises to cast, the orb charges at the tip, then
 *  the shot itself flies in world space (arenaRender owns the flight) */
function staff(ctx: CanvasRenderingContext2D, u: number, orb: string): void {
  const a = u < 0 ? 0.5 : track(u, [
    [0, 0.5],
    [0.2, -0.45],
    [0.55, -0.45],
    [1, 0.5],
  ]);
  ctx.save();
  ctx.rotate(a);
  blk(ctx, -6, -2, 32, 4, LEATHER); // shaft
  blk(ctx, -6, -2, 32, 1, "#8a6a45");
  blk(ctx, 25, -6, 10, 12, INK); // the head
  blk(ctx, 27, -4, 6, 8, orb);
  blk(ctx, 28, -3, 2, 2, PAPER); // glint
  ctx.restore();
  // charge sparks while the staff is raised
  if (u >= 0.18 && u < 0.5) {
    const tx = Math.cos(a) * 30;
    const ty = Math.sin(a) * 30;
    ctx.globalAlpha = 0.85;
    blk(ctx, tx - 2, ty - 8, 3, 3, orb);
    blk(ctx, tx + 5, ty - 3, 3, 3, PAPER);
    blk(ctx, tx - 7, ty + 1, 3, 3, orb);
    ctx.globalAlpha = 1;
  }
}

/** the armory portrait: each blade laid flat and centered on (0,0) — the
 *  rack picker draws these into little canvases. Same code sprites the
 *  fight renders, so the menu never lies about what you'll swing. */
export function drawWeaponIcon(ctx: CanvasRenderingContext2D, key: string): void {
  ctx.save();
  switch (key) {
    case "whip": {
      // the lash at rest: handle, then a lazy arc out to the poison tip
      ctx.translate(-19, 1);
      blk(ctx, -2, -2, 9, 4, WHIP_LEATHER);
      blk(ctx, -2, -2, 9, 1, "#5c554a");
      for (let i = 0; i <= 9; i++) {
        const t = i / 9;
        blk(
          ctx,
          7 + t * 30 - 1.5,
          -Math.sin(t * Math.PI) * 6 - 1.5,
          3,
          3,
          i > 7 ? WHIP_TIP : WHIP_LEATHER
        );
      }
      break;
    }
    case "dds":
      ctx.translate(-7, 0);
      ddsBlade(ctx);
      break;
    case "scim":
      ctx.translate(-14, 3);
      scimBlade(ctx);
      break;
    case "gmaul":
      ctx.translate(-16, 0);
      gmaulHead(ctx);
      break;
    case "ags":
      ctx.translate(-17, 0);
      agsBlade(ctx);
      break;
    case "elder":
      ctx.translate(-20, 0);
      elderHead(ctx);
      break;
    default:
      ctx.translate(-14, 3);
      scimBlade(ctx);
  }
  ctx.restore();
}

// --------------------------------------------------------------- entry --

/**
 * Draw a fighter's weapon. `u` is swing progress 0..1 (event time /
 * SWING_MS), or -1 at rest. Caller has translated to the bird's center and
 * mirrored via scale() so +x always faces the opponent.
 */
export function drawWeapon(
  ctx: CanvasRenderingContext2D,
  key: string,
  u: number,
  spec = false
): void {
  ctx.save();
  ctx.translate(CLAW_X, CLAW_Y);
  ctx.scale(ARM_SCALE, ARM_SCALE);
  if (spec && u >= 0 && u < 1) {
    // the spec burns hot for the whole swing: sparks in the weapon's own
    // colors spiral around the claw while a growing flare rides the blade
    const th = specTheme(key);
    ctx.globalAlpha = 0.9;
    for (let k = 0; k < 5; k++) {
      const a = u * 9 + (k * Math.PI * 2) / 5;
      const r = 9 + k * 3 + u * 7;
      blk(
        ctx,
        Math.cos(a) * r - 2,
        Math.sin(a) * r - 8,
        4,
        4,
        k % 2 ? th.b : th.a
      );
    }
    flash(ctx, 0, -14, 4 + u * 4);
    ctx.globalAlpha = 1;
  }
  switch (key) {
    case "whip":
      whip(ctx, u);
      break;
    case "ags":
      swingRot(ctx, u, -0.9, [
        [0, -0.9],
        [0.3, -2.6],
        [0.6, 0.9],
        [0.85, 0.9],
        [1, -0.9],
      ], 0.6, 40, agsBlade);
      break;
    case "scim":
      swingRot(ctx, u, -0.5, [
        [0, -0.5],
        [0.18, -2.1],
        [0.5, 0.7],
        [0.75, 0.7],
        [1, -0.5],
      ], 0.5, 30, scimBlade);
      break;
    case "dds":
      // the famous double-jab
      jab(ctx, u, [
        [0, 0],
        [0.14, 1],
        [0.3, 0.1],
        [0.48, 1],
        [0.7, 0],
        [1, 0],
      ], 16, ddsBlade);
      break;
    case "needle":
      jab(ctx, u, [
        [0, 0],
        [0.2, 1],
        [0.55, 0],
        [1, 0],
      ], 20, needleBlade);
      break;
    case "xbow":
      xbow(ctx, u);
      break;
    case "bow":
      bow(ctx, u);
      break;
    case "kodai":
    case "sang":
    case "tstaff":
      staff(ctx, u, STAFF_ORBS[key]);
      break;
    case "gmaul":
      swingRot(ctx, u, -0.6, [
        [0, -0.6],
        [0.32, -2.3],
        [0.46, 0.85],
        [0.8, 0.85],
        [1, -0.6],
      ], 0.46, 30, gmaulHead, true);
      break;
    case "boulder":
      swingRot(ctx, u, -0.6, [
        [0, -0.6],
        [0.38, -2.4],
        [0.55, 0.9],
        [0.85, 0.9],
        [1, -0.6],
      ], 0.55, 22, boulderHead, true);
      break;
    case "elder":
      swingRot(ctx, u, -0.7, [
        [0, -0.7],
        [0.42, -2.5],
        [0.58, 0.95],
        [0.88, 0.95],
        [1, -0.7],
      ], 0.58, 34, elderHead, true);
      break;
    default:
      // unknown key (old snapshot): the plain scim reads fine
      swingRot(ctx, u, -0.5, [
        [0, -0.5],
        [0.18, -2.1],
        [0.5, 0.7],
        [0.75, 0.7],
        [1, -0.5],
      ], 0.5, 30, scimBlade);
  }
  ctx.restore();
}
