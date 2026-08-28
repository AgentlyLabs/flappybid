// Shared physics constants. Imported by BOTH the client renderer and the
// server re-simulator — any drift between the two breaks score verification,
// so all tuning happens here and only here.

export const WIDTH = 480;
export const HEIGHT = 640;

export const TICK_HZ = 60;

export const GRAVITY = 0.48; // px / frame^2
export const FLAP_IMPULSE = -7.8; // px / frame
export const MAX_FALL_SPEED = 11.5;

export const BIRD_X = 120;
export const BIRD_RADIUS = 13;
export const BIRD_START_Y = 280;

export const SCROLL_SPEED = 2.9; // px / frame
export const PIPE_WIDTH = 68;
export const PIPE_GAP = 145; // vertical opening
export const PIPE_SPACING = 225; // horizontal distance between pipe centers
export const FIRST_PIPE_X = WIDTH + 140; // breathing room before pipe 0

export const GAP_CENTER_MIN = 130;
export const GAP_CENTER_MAX = HEIGHT - 180;

export const FLOOR_Y = HEIGHT - 64; // ground line; touching it ends the run

// Revive (the first microtransaction): on death a player can pay coins to
// reset to the start height and fly on. The reset drops the bird mid-screen
// with a short grace window in which nothing can kill it, so it can't respawn
// straight into the pipe it just hit. Part of the deterministic sim contract —
// the same on client and server, so a revived run replays bit-for-bit. ~1.5s
// at 60Hz, roughly one pipe-spacing of scroll.
export const REVIVE_INVULN_FRAMES = 90;

// Combat tuning shared by every shooting map. Same client/server contract
// as the physics above: these feed the deterministic sim on both sides, so
// they are frozen once anyone has played a combat map. Per-map knobs
// (cooldowns, spawn chances, gate cycles) live on each map's CombatDef.
export const BULLET_SPEED = 9; // px / frame, fired straight right
export const BULLET_RADIUS = 3;
export const TARGET_RADIUS = 14;
export const TARGET_Y_MIN = 90;
export const TARGET_Y_MAX = HEIGHT - 64 - 120; // stays clear of the floor
export const LASER_HALF_WIDTH = 3; // gate beam half-thickness for collision
export const BEAM_HALF_HEIGHT = 14; // the bird's mega-laser half-thickness

// Runs have no time limit. These payload bounds are what keeps the server
// re-simulator safe instead: the bird can't stay airborne more than a
// ceiling-to-floor fall (~100 frames) past its final flap, so the flap cap
// also bounds total sim length. 100k flaps ≈ half a day of nonstop play.
export const MAX_FLAPS = 100_000;
// Gun cooldown already caps real fire rate; this only bounds the payload.
export const MAX_SHOTS = 50_000;

// Bump whenever a change alters sim behavior (physics, RNG, spacing…) OR
// the submit protocol (v3: live checkpoints; v4: revive + reviveFrames;
// v5: global difficulty pass — every map retuned harder; v6: eased the v5
// pass back a bit — every map a touch more forgiving). The
// client stamps it on every submit; a stale bundle then gets a polite
// "refresh" instead of a replay mismatch or a missing-checkpoint rejection.
export const SIM_VERSION = 6;
