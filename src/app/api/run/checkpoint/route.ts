import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import {
  CHECKPOINT_EVERY_FRAMES,
  MAX_CHECKPOINTS,
  type CheckpointRow,
} from "@/game/checkpoint";

export const runtime = "nodejs";

// one beat every ~10s of sim per run. The "device" lane is keyed on ip_hash,
// which CGNAT shares across strangers — an active run emits ~6 beats/min, so
// this ceiling must fit every player behind one carrier NAT at once, not one
// browser's tabs; dropped beats here surface later as submit rejections
const perRun = makeLimiter({ windowMs: 60_000, max: 8, gapMs: 4_000 });
const perDevice = makeLimiter({ windowMs: 60_000, max: 120 });

const HASH_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-f]{16}$/;

// Mid-run progress commitment (see src/game/checkpoint.ts). The nonce chain
// makes the beats sequential: each append is only accepted with the nonce
// the previous response handed out, so the whole stream can't be fired
// blind from a script that never reads answers. A lost response is not
// fatal — the reply always carries the current nonce, so a live client can
// resync on the next beat.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  if (!perDevice(ipHashFrom(req))) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  let body: { runId?: unknown; frame?: unknown; hash?: unknown; nonce?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const runId = String(body.runId ?? "");
  const frame = Number(body.frame);
  const hash = String(body.hash ?? "");
  const nonce = String(body.nonce ?? "");
  if (
    !runId ||
    !Number.isSafeInteger(frame) ||
    frame < CHECKPOINT_EVERY_FRAMES ||
    !HASH_RE.test(hash) ||
    !NONCE_RE.test(nonce)
  ) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  if (!perRun(runId)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  const client = db();
  const { data: run, error } = await client
    .from("runs")
    .select("id, status, checkpoints, cp_nonce")
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    // checkpoint columns missing (older database) — a client
    // only streams beats when run/start handed it a nonce, so this is a
    // config skew; don't kill the run over it
    return NextResponse.json({ ok: true, disabled: true });
  }
  if (!run || run.status !== "open" || !run.cp_nonce) {
    return NextResponse.json({ error: "run not open" }, { status: 409 });
  }

  const cps: CheckpointRow[] = Array.isArray(run.checkpoints)
    ? (run.checkpoints as CheckpointRow[])
    : [];
  const lastFrame = cps.length ? cps[cps.length - 1].f : 0;

  // wrong nonce or replayed frame: refuse the append but hand back the
  // current nonce — a client whose previous response got lost resyncs here
  if (nonce !== run.cp_nonce || frame <= lastFrame) {
    return NextResponse.json({ ok: false, nonce: run.cp_nonce });
  }

  const next = randomBytes(8).toString("hex");
  // past the cap, rotate the nonce but stop recording — the flap cap will
  // bound the run before an honest player ever gets here
  const stored =
    cps.length >= MAX_CHECKPOINTS
      ? cps
      : [...cps, { f: frame, h: hash, t: Date.now() }];
  const { error: writeErr } = await client
    .from("runs")
    .update({ checkpoints: stored, cp_nonce: next })
    .eq("id", runId)
    .eq("cp_nonce", run.cp_nonce); // no double-append on a racing retry
  if (writeErr) {
    return NextResponse.json({ ok: false, nonce: run.cp_nonce });
  }
  return NextResponse.json({ ok: true, nonce: next });
}
