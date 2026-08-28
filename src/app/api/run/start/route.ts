import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomInt } from "crypto";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { BAN_MESSAGE, ipHashFrom, isBanned } from "@/lib/ban";
import { boostFor } from "@/lib/boost";
import { deviceIdFrom, newDeviceId, setDeviceCookie } from "@/lib/device";
import { HUMAN_COOKIE, humanCheckEnabled, isHumanPass } from "@/lib/human";
import { isMapId } from "@/game/maps";
import { utcDay, isRetired } from "@/lib/day";

export const runtime = "nodejs";

// A restart is a death plus a click — even an instant-death loop can't
// sustain a start every 2s for a whole minute, but a seed-farming script can
const allowed = makeLimiter({ windowMs: 60_000, max: 30, gapMs: 750 });

// Issue a run: server-generated seed, server-side row. The client can only
// play the pipes this seed produces — it never picks its own layout.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the bird needs a breather" },
      { status: 429 }
    );
  }

  // Turnstile day-pass: only enforced once the env is configured. The
  // client sees humanCheck, solves an invisible challenge at /api/human
  // and retries — a real browser does this once a day.
  if (
    humanCheckEnabled() &&
    !isHumanPass(req.cookies.get(HUMAN_COOKIE)?.value, ipHash)
  ) {
    return NextResponse.json(
      { error: "quick human check needed", humanCheck: true },
      { status: 403 }
    );
  }

  let body: { productId?: string; mapId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const productId = String(body.productId ?? "");
  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const client = db();
  const { data: product } = await client
    .from("products")
    .select("id, last_won_on")
    .eq("id", productId)
    .maybeSingle();
  if (!product) {
    return NextResponse.json({ error: "unknown product" }, { status: 404 });
  }

  if (isRetired(product.last_won_on)) {
    return NextResponse.json(
      {
        error: `Champion — this product won ${product.last_won_on} and retired undefeated. One win, ever.`,
        retired: true,
      },
      { status: 403 }
    );
  }

  // blacklisted entries and devices don't get a seed at all
  const deviceId = deviceIdFrom(req) ?? newDeviceId();
  if (await isBanned(client, product.id, { ipHashes: [ipHash], deviceIds: [deviceId] })) {
    return NextResponse.json({ error: BAN_MESSAGE, banned: true }, { status: 403 });
  }

  const seed = randomInt(1, 2 ** 31 - 1);
  // the player's map choice, frozen onto the run — replay verifies against
  // this stored value, never against anything the client says later
  const map = isMapId(body.mapId) ? body.mapId : "classic";
  // first link of the live-checkpoint nonce chain (see /api/run/checkpoint)
  const cpNonce = randomBytes(8).toString("hex");
  const base = { product_id: product.id, day: utcDay(), seed, ip_hash: ipHash };
  // newest schema first; each retry peels off the columns a missing
  // migration can't hold (cp_nonce, device_id, map)
  const attempts = [
    {
      insert: { ...base, map, device_id: deviceId, cp_nonce: cpNonce },
      select: "id, seed, day, map, cp_nonce",
    },
    { insert: { ...base, map, device_id: deviceId }, select: "id, seed, day, map" },
    { insert: { ...base, map }, select: "id, seed, day, map" },
    { insert: base, select: "id, seed, day" },
  ];
  interface StartRow {
    id: string;
    seed: number;
    day: string;
    map?: string;
    cp_nonce?: string;
  }
  let run: StartRow | null = null;
  let error: { code?: string } | null = null;
  for (const a of attempts) {
    const res = await client.from("runs").insert(a.insert).select(a.select).single();
    run = res.data as StartRow | null;
    error = res.error;
    if (error?.code !== "PGRST204") break;
  }
  if (error || !run) {
    return NextResponse.json({ error: "could not start run" }, { status: 500 });
  }

  // display hint for the in-game counter — the authoritative boost check
  // happens again at submit, against the same run day
  const boost = await boostFor(client, run.day, ipHash);

  // the client must sim the map the SERVER stored — echo it back; same for
  // day, so a run straddling midnight still plays the day it's verified on
  const res = NextResponse.json({
    runId: run.id,
    seed: Number(run.seed),
    map: run.map ?? "classic",
    day: run.day,
    boost,
    // checkpointing is on only when the row could store the nonce — the
    // client streams beats iff this field exists
    ...(run.cp_nonce ? { cp: run.cp_nonce } : {}),
  });
  // (re)issue the device cookie — a fresh mint sticks, an existing one gets
  // its year-long clock wound back up
  setDeviceCookie(res, deviceId);
  return res;
}
