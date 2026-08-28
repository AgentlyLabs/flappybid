import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizeRuleset } from "@/game/duel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A resolved fight, scripts included, for the spectator player. Scripts of
// *resolved* fights are public by design — every fight is rewatchable, and
// a ghost's flight path is only secret while its challenge is open (the
// acceptor already got it at accept time).
export async function GET(req: NextRequest) {
  const matchId = req.nextUrl.searchParams.get("matchId") ?? "";
  if (!matchId) {
    return NextResponse.json({ error: "matchId required" }, { status: 400 });
  }
  const client = db();
  const { data: m } = await client
    .from("duel_matches")
    .select(
      "id, duel_id, nickname, script, winner, ko, frames, ghost_hp, challenger_hp, ghost_dmg, challenger_dmg, created_at, duels!inner(nickname, taunt, script, ruleset, mode, status)"
    )
    .eq("id", matchId)
    .maybeSingle();
  if (!m) {
    return NextResponse.json({ error: "unknown fight" }, { status: 404 });
  }
  const duel = (Array.isArray(m.duels) ? m.duels[0] : m.duels) as {
    nickname: string;
    taunt: string | null;
    script: number[];
    ruleset: unknown;
    mode: string;
    status: string;
  };

  return NextResponse.json({
    matchId: m.id,
    duelId: m.duel_id,
    ghost: { nickname: duel.nickname, taunt: duel.taunt, script: duel.script },
    challenger: { nickname: m.nickname, script: m.script },
    ruleset: normalizeRuleset(duel.ruleset),
    verdict: {
      winner: m.winner,
      ko: m.ko,
      frames: m.frames,
      ghostHp: m.ghost_hp,
      challengerHp: m.challenger_hp,
      ghostDmg: m.ghost_dmg,
      challengerDmg: m.challenger_dmg,
    },
    createdAt: m.created_at,
  });
}
