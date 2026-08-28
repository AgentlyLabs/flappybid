import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeLimiter, sameOrigin, ORIGIN_MESSAGE } from "@/lib/abuse";
import { ipHashFrom } from "@/lib/ban";
import { deviceIdFrom } from "@/lib/device";
import { utcDay } from "@/lib/day";

export const runtime = "nodejs";

// the grant is one row per device per day, so anything past a few clicks a
// minute is a script poking the endpoint
const allowed = makeLimiter({ windowMs: 60_000, max: 10, gapMs: 1_000 });

// Claim the Product Hunt vote boost: the click that opens the PH page also
// lands here, marking this device as 2x for today. The click is the grant —
// there's no way to verify the vote actually happened — and one grant per
// device per day is the whole table's constraint, so replaying this endpoint
// is a no-op.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: ORIGIN_MESSAGE }, { status: 403 });
  }
  const ipHash = ipHashFrom(req);
  if (!allowed(ipHash)) {
    return NextResponse.json(
      { error: "slow down — the boost is already yours" },
      { status: 429 }
    );
  }

  const day = utcDay();
  // remember which device claimed it, when the cookie exists — pure signal
  // for review, the (ip_hash, day) grant key is unchanged
  const deviceId = deviceIdFrom(req);
  let { error } = await db()
    .from("ph_votes")
    .upsert(
      { ip_hash: ipHash, day, ...(deviceId ? { device_id: deviceId } : {}) },
      { onConflict: "ip_hash,day", ignoreDuplicates: true }
    );
  if (error?.code === "PGRST204" && deviceId) {
    // ph_votes.device_id missing (older database)
    ({ error } = await db()
      .from("ph_votes")
      .upsert(
        { ip_hash: ipHash, day },
        { onConflict: "ip_hash,day", ignoreDuplicates: true }
      ));
  }
  if (error) {
    // table missing (older database) or a write hiccup — the
    // button already opened PH, so just say so honestly
    return NextResponse.json({ error: "could not record the boost" }, { status: 500 });
  }
  return NextResponse.json({ active: true, day });
}
