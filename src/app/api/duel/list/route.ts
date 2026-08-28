import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DUEL_VERSION, normalizeRuleset } from "@/game/duel";
import type { DuelRow } from "@/lib/duels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The duel board: open, unexpired ghosts (newest first), plus the latest
// resolved fights for the results tab. Scripts never leave the server here —
// a challenger sees the bird and its record, not its flight path.
export async function GET() {
  const client = db();
  const nowIso = new Date().toISOString();

  const { data: duels } = await client
    .from("duels")
    .select(
      "id, status, mode, nickname, taunt, ruleset, duel_version, wins, losses, draws, expires_at, created_at"
    )
    .eq("status", "open")
    .eq("duel_version", DUEL_VERSION)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: recent } = await client
    .from("duel_matches")
    .select(
      "id, duel_id, nickname, winner, ko, frames, ghost_dmg, challenger_dmg, created_at, duels!inner(nickname)"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    duels: ((duels ?? []) as Omit<DuelRow, "script">[]).map((d) => ({
      id: d.id,
      nickname: d.nickname,
      taunt: d.taunt,
      ruleset: normalizeRuleset(d.ruleset),
      mode: d.mode,
      wins: d.wins,
      losses: d.losses,
      draws: d.draws,
      expiresAt: d.expires_at,
      createdAt: d.created_at,
    })),
    recent: (recent ?? []).map((m) => {
      // supabase-js types joined rows as an array even for a to-one join
      const ghost = Array.isArray(m.duels) ? m.duels[0] : m.duels;
      return {
        matchId: m.id,
        duelId: m.duel_id,
        ghostNickname: (ghost as { nickname: string } | null)?.nickname ?? "?",
        challengerNickname: m.nickname,
        winner: m.winner,
        ko: m.ko,
        frames: m.frames,
        ghostDmg: m.ghost_dmg,
        challengerDmg: m.challenger_dmg,
        createdAt: m.created_at,
      };
    }),
  });
}
