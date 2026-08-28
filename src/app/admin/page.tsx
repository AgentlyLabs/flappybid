import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { db } from "@/lib/db";
import { isAdminHandle } from "@/lib/admin";
import { championCandidate } from "@/lib/close";
import { utcDay } from "@/lib/day";
import { ONLINE_WINDOW_MS } from "@/lib/presence";
import { xHandleFromToken, X_SESSION_COOKIE } from "@/lib/x";
import {
  banConfidence,
  suspicionTags,
  type BanConfidence,
  type SuspicionTag,
} from "@/lib/suspicion";
import { CHECKPOINT_EVERY_FRAMES } from "@/game/checkpoint";
import { analyzeRun } from "@/game/detect";
import { MAPS, MAP_LIST, isMapId } from "@/game/maps";
import { TICK_HZ } from "@/game/constants";
import AdminAction from "@/components/AdminAction";
import AdminAnnounceForm from "@/components/AdminAnnounceForm";
import BoardReplay from "@/components/BoardReplay";
import ReplayViewer from "@/components/ReplayViewer";

export const dynamic = "force-dynamic";

// Owner dashboard. Server-gated: the page reads the HttpOnly X session
// cookie, resolves the OAuth-verified handle and only renders for the two
// ADMIN_HANDLES. Everyone else gets the connect gate — no data ever leaves
// the server for them.
//
// The dashboard is split into tabs via ?tab=; each tab only runs its own
// queries so the heavy ones (champion review, 14-day analytics) don't slow
// down a quick chat-moderation visit.

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

const TABS = [
  { id: "review", label: "review" },
  { id: "board", label: "board" },
  { id: "analytics", label: "analytics" },
  { id: "sponsors", label: "sponsors" },
  { id: "logos", label: "logos" },
  { id: "chat", label: "chat" },
  { id: "announce", label: "announce" },
  { id: "bans", label: "bans" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function resolveTab(raw: string | string[] | undefined): TabId {
  const t = Array.isArray(raw) ? raw[0] : raw;
  return (TABS.find((x) => x.id === t)?.id ?? "review") as TabId;
}

type Client = ReturnType<typeof db>;

interface BoardRow {
  product_id: string;
  best_score: number;
  runs_count: number;
  clicks_count: number;
  products: { name: string; slug: string };
}

interface SponsorRow {
  id: string;
  name: string;
  pitch: string;
  url: string;
  status: "pending" | "live" | "rejected" | "expired";
  price_cents: number;
  clicks_count: number;
  created_at: string;
}

interface LogoBidRow {
  id: string;
  brand: string;
  url: string | null;
  logo_data_url: string;
  status: "pending" | "approved" | "rejected";
  price_cents: number;
  created_at: string;
}

interface ChatRow {
  id: number;
  name: string;
  body: string;
  x_handle: string;
  created_at: string;
}

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  active: boolean;
  created_by: string;
  created_at: string;
}

interface BanRow {
  id: string;
  product_id: string | null;
  ip_hash: string | null;
  reason: string;
  created_at: string;
}

interface PendingReview {
  day: string;
  productId: string;
  productName: string;
  productSlug: string;
  score: number;
  runsCount: number;
  tags: SuspicionTag[];
  run: {
    id: string;
    seed: number;
    flapFrames: number[];
    shootFrames: number[];
    map: string;
    tell: string | null;
    /** runs submitted by the same device (ip hash OR device cookie) that day */
    deviceRuns: number | null;
    flapCount: number;
    durationSec: number;
    intervalStdDev: number | null;
    offsetStdDev: number | null;
    /** beats streamed during the run; null = pre-checkpoint-protocol run */
    liveBeats: number | null;
    /** beats a run of this length should have streamed */
    expectedBeats: number;
  } | null;
}

// Past days with scores that never closed, each waiting for a champion
// verdict. Normally just yesterday; more if a review was skipped.
async function unclosedDays(client: Client, today: string) {
  const { data: dayRows } = await client
    .from("daily_scores")
    .select("day")
    .lt("day", today)
    .gt("best_score", 0)
    .order("day", { ascending: false })
    .limit(1000);
  const days = [...new Set((dayRows ?? []).map((r) => r.day as string))];
  if (!days.length) return [];
  const { data: hallRows } = await client
    .from("hall_of_fame")
    .select("date")
    .in("date", days);
  const closed = new Set((hallRows ?? []).map((r) => r.date as string));
  return days.filter((d) => !closed.has(d));
}

async function pendingReviews(client: Client, today: string) {
  const days = await unclosedDays(client, today);
  const out: PendingReview[] = [];
  for (const day of days.slice(0, 5)) {
    const cand = await championCandidate(day);
    if (!cand) continue;
    let run: PendingReview["run"] = null;
    if (cand.run) {
      const runMap = isMapId(cand.run.map) ? MAPS[cand.run.map] : MAPS.classic;
      const stats = analyzeRun(
        cand.run.seed,
        cand.run.flap_frames,
        cand.run.shot_frames ?? [],
        runMap
      );
      let deviceRuns: number | null = null;
      // both identities the run carries, same OR the profiler careers on —
      // a proxy-rotating device can't shrink this number anymore
      const idConds = [
        cand.run.ip_hash ? `ip_hash.eq.${cand.run.ip_hash}` : null,
        cand.run.device_id ? `device_id.eq.${cand.run.device_id}` : null,
      ].filter(Boolean) as string[];
      if (idConds.length) {
        const { count } = await client
          .from("runs")
          .select("id", { count: "exact", head: true })
          .or(idConds.join(","))
          .eq("day", day);
        deviceRuns = count;
      }
      run = {
        id: cand.run.id,
        seed: cand.run.seed,
        flapFrames: cand.run.flap_frames,
        shootFrames: cand.run.shot_frames ?? [],
        map: cand.run.map,
        tell: cand.run.cheat_reason,
        deviceRuns,
        flapCount: stats.flapCount,
        durationSec: Math.round(stats.frames / TICK_HZ),
        intervalStdDev: stats.intervalStdDev,
        offsetStdDev: stats.offsetStdDev,
        // submit already enforced these; shown so the reviewer knows which
        // verification regime the run lived under
        liveBeats: cand.run.cp_nonce
          ? Array.isArray(cand.run.checkpoints)
            ? cand.run.checkpoints.length
            : 0
          : null,
        expectedBeats: Math.floor(stats.frames / CHECKPOINT_EVERY_FRAMES),
      };
    }
    out.push({
      day,
      productId: cand.productId,
      productName: cand.product.name,
      productSlug: cand.product.slug,
      score: cand.bestScore,
      runsCount: cand.runsCount,
      tags: await suspicionTags(client, cand.productId, day),
      run,
    });
  }
  return out;
}

// Always fetched: the strip above the tabs plus the two badge counts.
async function headerData(client: Client, today: string) {
  const sinceIso = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const [
    online,
    total,
    runsToday,
    cheatsToday,
    pendingSponsors,
    pendingLogos,
    reviewDays,
  ] = await Promise.all([
      client
        .from("visitors")
        .select("id", { count: "exact", head: true })
        .gt("last_seen", sinceIso),
      client.from("visitors").select("id", { count: "exact", head: true }),
      client
        .from("runs")
        .select("id", { count: "exact", head: true })
        .eq("day", today),
      client
        .from("runs")
        .select("id", { count: "exact", head: true })
        .eq("day", today)
        .eq("status", "cheated"),
      client
        .from("sponsors")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      client
        .from("logo_bids")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      unclosedDays(client, today),
    ]);
  return {
    online: online.count ?? 0,
    total: total.count ?? 0,
    runsToday: runsToday.count ?? 0,
    cheatsToday: cheatsToday.count ?? 0,
    pendingSponsors: pendingSponsors.count ?? 0,
    pendingLogos: pendingLogos.count ?? 0,
    pendingReviews: reviewDays.length,
  };
}

async function boardData(client: Client, today: string) {
  const { data } = await client
    .from("daily_scores")
    .select("product_id, best_score, runs_count, clicks_count, products(name, slug)")
    .eq("day", today)
    .order("best_score", { ascending: false })
    .limit(20);
  const rows = (data as unknown as BoardRow[]) ?? [];
  const tags = Object.fromEntries(
    await Promise.all(
      rows.map(async (row) => [
        row.product_id,
        await suspicionTags(client, row.product_id, today),
      ])
    )
  ) as Record<string, SuspicionTag[]>;
  return { rows, tags };
}

interface DayPoint {
  day: string;
  runs: number;
  cheats: number;
  newVisitors: number;
  entries: number;
}

interface Analytics {
  trend: DayPoint[];
  mapCounts: { id: string; label: string; count: number }[];
  clicksToday: number;
  showcaseToday: number;
  chatToday: number;
  phToday: number;
  xConnected: number;
  playersWindow: number;
  playersToday: number;
  returningPlayers: number;
  sponsorRevenueCents: number;
  sponsorPendingCents: number;
  sponsorLive: number;
  sponsorClicks: number;
  champions: number;
  bestEver: number;
  avgChampion: number;
  championClicks: number;
}

const TREND_DAYS = 14;
const MAP_WINDOW_DAYS = 7;

async function analyticsData(client: Client, today: string): Promise<Analytics> {
  const days: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    days.push(utcDay(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }
  const dayStart = (d: string) => `${d}T00:00:00.000Z`;
  const dayEnd = (d: string) =>
    new Date(Date.parse(dayStart(d)) + 24 * 60 * 60 * 1000).toISOString();
  const mapSince = utcDay(
    new Date(Date.now() - (MAP_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000)
  );

  const headCount = (q: PromiseLike<{ count: number | null }>) =>
    Promise.resolve(q).then((r) => r.count ?? 0);

  const [
    runsPerDay,
    cheatsPerDay,
    visitorsPerDay,
    entryDays,
    mapRows,
    clicksRows,
    showcaseToday,
    chatToday,
    phToday,
    xConnected,
    playerStats,
    sponsorRows,
    hallRows,
  ] = await Promise.all([
    Promise.all(
      days.map((d) =>
        headCount(
          client
            .from("runs")
            .select("id", { count: "exact", head: true })
            .eq("day", d)
        )
      )
    ),
    Promise.all(
      days.map((d) =>
        headCount(
          client
            .from("runs")
            .select("id", { count: "exact", head: true })
            .eq("day", d)
            .eq("status", "cheated")
        )
      )
    ),
    Promise.all(
      days.map((d) =>
        headCount(
          client
            .from("visitors")
            .select("id", { count: "exact", head: true })
            .gte("first_seen", dayStart(d))
            .lt("first_seen", dayEnd(d))
        )
      )
    ),
    client
      .from("daily_scores")
      .select("day")
      .gte("day", days[0])
      .limit(10000)
      .then((r) => (r.data ?? []).map((x) => x.day as string)),
    Promise.all(
      MAP_LIST.map(async (m) => ({
        id: m.id,
        label: m.label,
        count: await headCount(
          client
            .from("runs")
            .select("id", { count: "exact", head: true })
            .gte("day", mapSince)
            .eq("map", m.id)
        ),
      }))
    ),
    client
      .from("daily_scores")
      .select("clicks_count")
      .eq("day", today)
      .limit(1000)
      .then((r) => (r.data ?? []).map((x) => x.clicks_count as number)),
    headCount(
      client
        .from("showcase_clicks")
        .select("id", { count: "exact", head: true })
        .eq("date", today)
    ),
    headCount(
      client
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayStart(today))
    ),
    headCount(
      client
        .from("ph_votes")
        .select("ip_hash", { count: "exact", head: true })
        .eq("day", today)
    ),
    headCount(
      client.from("x_connections").select("x_id", { count: "exact", head: true })
    ),
    // distinct-player counts (device_id, ip_hash fallback) — set-based in the
    // db. If the RPC hasn't shipped yet the tab still renders with zeros.
    client
      .rpc("admin_player_stats", { since_day: days[0], today_day: today })
      .then(
        (r) =>
          ((r.data as
            | {
                players_window: number;
                players_today: number;
                returning_players: number;
              }[]
            | null)?.[0] ?? null)
      ),
    client
      .from("sponsors")
      .select("status, price_cents, clicks_count")
      .limit(1000)
      .then(
        (r) =>
          (r.data ?? []) as {
            status: SponsorRow["status"];
            price_cents: number;
            clicks_count: number;
          }[]
      ),
    client
      .from("hall_of_fame")
      .select("best_score, clicks_sent")
      .limit(1000)
      .then(
        (r) => (r.data ?? []) as { best_score: number; clicks_sent: number }[]
      ),
  ]);

  const entriesByDay = new Map<string, number>();
  for (const d of entryDays) {
    entriesByDay.set(d, (entriesByDay.get(d) ?? 0) + 1);
  }

  const trend: DayPoint[] = days.map((day, i) => ({
    day,
    runs: runsPerDay[i],
    cheats: cheatsPerDay[i],
    newVisitors: visitorsPerDay[i],
    entries: entriesByDay.get(day) ?? 0,
  }));

  const paid = sponsorRows.filter(
    (s) => s.status === "live" || s.status === "expired"
  );
  return {
    trend,
    mapCounts: mapRows.sort((a, b) => b.count - a.count),
    clicksToday: clicksRows.reduce((a, b) => a + b, 0),
    showcaseToday,
    chatToday,
    phToday,
    xConnected,
    playersWindow: playerStats?.players_window ?? 0,
    playersToday: playerStats?.players_today ?? 0,
    returningPlayers: playerStats?.returning_players ?? 0,
    sponsorRevenueCents: paid.reduce((a, s) => a + s.price_cents, 0),
    sponsorPendingCents: sponsorRows
      .filter((s) => s.status === "pending")
      .reduce((a, s) => a + s.price_cents, 0),
    sponsorLive: sponsorRows.filter((s) => s.status === "live").length,
    sponsorClicks: sponsorRows.reduce((a, s) => a + s.clicks_count, 0),
    champions: hallRows.length,
    bestEver: hallRows.reduce((a, h) => Math.max(a, h.best_score), 0),
    avgChampion: hallRows.length
      ? Math.round(
          hallRows.reduce((a, h) => a + h.best_score, 0) / hallRows.length
        )
      : 0,
    championClicks: hallRows.reduce((a, h) => a + h.clicks_sent, 0),
  };
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pixel-card p-4">
      <h2 className="font-pixel text-[10px] uppercase tracking-widest mb-4">
        {title}
      </h2>
      {children}
    </section>
  );
}

// The one-word verdict the ban button leans on, derived from the chips.
function ConfidenceChip({ tags }: { tags: SuspicionTag[] }) {
  const level: BanConfidence = banConfidence(tags);
  const styles: Record<BanConfidence, string> = {
    high: "border-red text-red",
    medium: "border-orange-deep text-orange-deep",
    low: "border-ink/40 text-muted",
  };
  return (
    <span
      className={`font-pixel text-[8px] uppercase px-1.5 py-0.5 border-2 whitespace-nowrap ${styles[level]}`}
      title="how confidently the evidence above supports a ban"
    >
      ban: {level}
    </span>
  );
}

// Bot-suspicion tags: red = probably a bot, gray = statistically odd.
// Advisory only — the human wearing the crown button makes the call.
function SuspicionChips({ tags }: { tags: SuspicionTag[] }) {
  if (!tags.length) return null;
  return (
    <div className="w-full space-y-1">
      {tags.map((t) => (
        <p key={t.label} className="text-sm leading-snug">
          <span
            className={`font-pixel text-[8px] uppercase px-1.5 py-0.5 border-2 mr-2 whitespace-nowrap ${
              t.severity === "high"
                ? "border-red text-red"
                : "border-ink/40 text-muted"
            }`}
          >
            {t.severity === "high" ? "⚠ " : ""}
            {t.label}
          </span>
          <span className="text-muted">{t.detail}</span>
        </p>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="font-pixel text-lg text-orange-deep">{value}</p>
      <p className="text-sm uppercase text-muted mt-1">{label}</p>
      {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
    </div>
  );
}

// 14 stacked pixel bars: bar height = runs that day, red cap = the cheated
// share of those runs. Server-rendered — no chart library, no client JS.
function TrendChart({ points }: { points: DayPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.runs));
  return (
    <div>
      <div className="flex items-end gap-1 h-36">
        {points.map((p) => {
          const h = Math.max(p.runs > 0 ? 4 : 0, (p.runs / max) * 100);
          const cheatH = p.runs > 0 ? (p.cheats / p.runs) * 100 : 0;
          return (
            <div
              key={p.day}
              className="flex-1 flex flex-col justify-end h-full"
              title={`${p.day}: ${p.runs} runs, ${p.cheats} cheated, ${p.newVisitors} new visitors`}
            >
              {p.runs > 0 ? (
                <div
                  className="w-full border-2 border-ink bg-orange flex flex-col"
                  style={{ height: `${h}%` }}
                >
                  {p.cheats > 0 && (
                    <div className="w-full bg-red" style={{ height: `${cheatH}%` }} />
                  )}
                </div>
              ) : (
                <div className="w-full border-t-2 border-ink/30" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-1">
        {points.map((p) => (
          <span
            key={p.day}
            className="flex-1 text-center font-pixel text-[7px] text-muted"
          >
            {p.day.slice(8)}
          </span>
        ))}
      </div>
      <p className="text-sm text-muted mt-2">
        <span className="inline-block w-3 h-3 bg-orange border-2 border-ink align-middle mr-1" />
        runs ·{" "}
        <span className="inline-block w-3 h-3 bg-red border-2 border-ink align-middle mr-1" />
        cheated share · hover a bar for exact numbers · dates are UTC
      </p>
    </div>
  );
}

function MapBars({ rows }: { rows: Analytics["mapCounts"] }) {
  const total = rows.reduce((a, r) => a + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3">
          <span className="font-pixel text-[8px] uppercase w-36 shrink-0 truncate">
            {r.label}
          </span>
          <div className="flex-1 h-4 bg-sand/60">
            <div
              className="h-full bg-pipe border-2 border-ink"
              style={{ width: `${Math.max(r.count > 0 ? 3 : 0, (r.count / max) * 100)}%` }}
            />
          </div>
          <span className="text-sm text-muted w-24 text-right shrink-0">
            {r.count.toLocaleString()}
            {total > 0 && ` (${Math.round((r.count / total) * 100)}%)`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-1.5 font-pixel text-[8px] bg-red text-white px-1 py-0.5 border-2 border-ink">
      {n}
    </span>
  );
}

function Gate({ handle }: { handle: string | null }) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="font-pixel text-lg text-white text-outline leading-relaxed">
        Admin tools
      </h1>
      {handle ? (
        <p className="text-xl mt-6">
          @{handle} isn&apos;t an owner account. This page is for the site
          owners only.
        </p>
      ) : (
        <>
          <p className="text-xl mt-6">
            Owners only. Connect the X account of a site owner to enter, then
            come back to /admin.
          </p>
          <a
            href="/api/x/connect"
            className="pixel-btn bg-orange text-white font-pixel text-[10px] px-4 py-3 inline-block mt-6"
          >
            connect 𝕏
          </a>
        </>
      )}
    </div>
  );
}

function ReviewTab({ reviews }: { reviews: PendingReview[] }) {
  return (
    <Section title="Champion review">
      {reviews.length === 0 ? (
        <p className="text-lg text-muted">
          Nothing awaiting review — every closed day has its champion.
        </p>
      ) : (
        <ul className="space-y-8">
          {reviews.map((r) => (
            <li key={r.day}>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="font-pixel text-[10px] text-orange-deep">
                  {r.day}
                </span>
                {r.run && (
                  <span className="font-pixel text-[8px] uppercase text-muted whitespace-nowrap">
                    {(isMapId(r.run.map) ? MAPS[r.run.map] : MAPS.classic).label}
                  </span>
                )}
                <span className="text-lg truncate">
                  {r.productName}{" "}
                  <span className="text-muted">({r.productSlug})</span>
                </span>
                <span className="ml-auto font-pixel text-[10px]">
                  {r.score}
                </span>
              </div>
              {r.run ? (
                <>
                  <p className="text-base text-muted mb-1">
                    {r.run.flapCount} flaps over {r.run.durationSec}s ·{" "}
                    {r.runsCount} runs on this entry
                    {r.run.deviceRuns !== null &&
                      ` · ${r.run.deviceRuns} runs from this device`}
                    {r.run.intervalStdDev !== null &&
                      ` · tap jitter ${r.run.intervalStdDev.toFixed(1)}f`}
                    {r.run.offsetStdDev !== null &&
                      ` · gap spread ${r.run.offsetStdDev.toFixed(1)}px`}
                  </p>
                  <p
                    className={`text-base mb-1 ${
                      r.run.liveBeats === null ? "text-orange-deep" : "text-muted"
                    }`}
                  >
                    {r.run.liveBeats === null
                      ? "○ pre-checkpoint run — no live audit on record"
                      : `● streamed live: ${r.run.liveBeats}${
                          r.run.expectedBeats
                            ? `/${r.run.expectedBeats} beats`
                            : " beats (run too short to require any)"
                        } verified against the submitted inputs`}
                  </p>
                  <p
                    className={`text-base mb-3 ${r.run.tell ? "text-red" : "text-muted"}`}
                  >
                    {r.run.tell
                      ? `⚠ detector: ${r.run.tell}`
                      : "no behavioral tells"}
                  </p>
                  <div className="mb-3 space-y-2">
                    <ConfidenceChip tags={r.tags} />
                    {r.tags.length > 0 && <SuspicionChips tags={r.tags} />}
                  </div>
                  <ReplayViewer
                    seed={r.run.seed}
                    flapFrames={r.run.flapFrames}
                    shootFrames={r.run.shootFrames}
                    mapId={r.run.map}
                  />
                  <div className="flex gap-3 mt-3">
                    <AdminAction
                      label="crown champion"
                      path="/api/admin/review"
                      body={{ runId: r.run.id, verdict: "approve" }}
                      confirmText={`Crown "${r.productName}" (${r.score}) as the champion of ${r.day}? This is forever.`}
                      className="pixel-btn bg-gold font-pixel text-[8px] px-3 py-2"
                    />
                    <AdminAction
                      label="reject run"
                      path="/api/admin/review"
                      body={{ runId: r.run.id, verdict: "reject" }}
                      confirmText={`Disqualify this run? The entry's next-best run takes its place for review. (This bans nobody — use the board's ban button for that.)`}
                      className="pixel-btn bg-paper font-pixel text-[8px] px-3 py-2"
                    />
                    <AdminAction
                      label="ban device"
                      path="/api/admin/ban"
                      body={{ runId: r.run.id }}
                      confirmText={`Permanently ban the device behind this run (IP hash + browser cookie)? Its scored runs come off the board too; the entry "${r.productName}" stays playable for everyone else.`}
                      className="pixel-btn bg-paper font-pixel text-[8px] px-3 py-2"
                    />
                  </div>
                </>
              ) : (
                <p className="text-base text-red">
                  No replay stored for this run — cannot review it here.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function BoardTab({
  board,
  tags,
  today,
}: {
  board: BoardRow[];
  tags: Record<string, SuspicionTag[]>;
  today: string;
}) {
  return (
    <Section title={`Today's board — ${today}`}>
      {board.length === 0 ? (
        <p className="text-lg text-muted">No entries yet today.</p>
      ) : (
        <ul className="space-y-2">
          {board.map((row, i) => (
            <li
              key={row.product_id}
              className="flex flex-wrap items-center gap-3"
            >
              <span className="font-pixel text-[10px] w-6 text-muted">
                {i + 1}
              </span>
              <span className="text-lg truncate">
                {row.products.name}{" "}
                <span className="text-muted">({row.products.slug})</span>
              </span>
              <span className="ml-auto font-pixel text-[10px] text-orange-deep">
                {row.best_score}
              </span>
              <span className="text-sm text-muted w-16 text-right">
                {row.runs_count} runs
              </span>
              <span className="text-sm text-muted w-16 text-right">
                {row.clicks_count} clicks
              </span>
              <ConfidenceChip tags={tags[row.product_id] ?? []} />
              <BoardReplay productId={row.product_id} />
              <AdminAction
                label="ban entry"
                path="/api/admin/ban"
                body={{ productId: row.product_id }}
                confirmText={`Permanently ban "${row.products.name}" and wipe it off today's board? If a hostile submitter flew the bot run, ban the device instead — the entry never proves who played "for" it.`}
              />
              <AdminAction
                label="ban device"
                path="/api/admin/ban"
                body={{ productId: row.product_id, target: "device" }}
                confirmText={`Permanently ban the device behind "${row.products.name}"'s best run today (IP hash + browser cookie)? Its runs come off the board; the entry stays playable for others.`}
              />
              {(tags[row.product_id] ?? []).length > 0 && (
                <div className="w-full pl-9">
                  <SuspicionChips tags={tags[row.product_id]} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AnalyticsTab({
  a,
  online,
  total,
  runsToday,
}: {
  a: Analytics;
  online: number;
  total: number;
  runsToday: number;
}) {
  const totalRuns = a.trend.reduce((x, p) => x + p.runs, 0);
  const totalCheats = a.trend.reduce((x, p) => x + p.cheats, 0);
  const totalVisitors = a.trend.reduce((x, p) => x + p.newVisitors, 0);
  return (
    <>
      <Section title={`Activity — last ${TREND_DAYS} days`}>
        <TrendChart points={a.trend} />
        <p className="text-base mt-3">
          {totalRuns.toLocaleString()} runs ·{" "}
          <span className={totalCheats > 0 ? "text-red" : ""}>
            {totalCheats.toLocaleString()} cheated (
            {totalRuns ? ((totalCheats / totalRuns) * 100).toFixed(1) : "0.0"}
            %)
          </span>{" "}
          · {totalVisitors.toLocaleString()} new visitors
        </p>
        <div className="overflow-x-auto mt-4 pt-4 border-t-[3px] border-ink/20">
          <table className="w-full text-sm">
            <thead>
              <tr className="font-pixel text-[8px] uppercase text-muted text-right">
                <th className="text-left font-normal pb-2">day</th>
                <th className="font-normal pb-2">runs</th>
                <th className="font-normal pb-2">cheated</th>
                <th className="font-normal pb-2">new visitors</th>
                <th className="font-normal pb-2">entries</th>
              </tr>
            </thead>
            <tbody>
              {[...a.trend].reverse().map((p) => (
                <tr key={p.day} className="text-right">
                  <td className="text-left text-muted py-0.5">{p.day}</td>
                  <td>{p.runs.toLocaleString()}</td>
                  <td className={p.cheats > 0 ? "text-red" : "text-muted"}>
                    {p.cheats.toLocaleString()}
                  </td>
                  <td>{p.newVisitors.toLocaleString()}</td>
                  <td>{p.entries.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Players — last ${TREND_DAYS} days`}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat label="players" value={a.playersWindow.toLocaleString()} />
          <Stat
            label="avg runs / player"
            value={
              a.playersWindow ? (totalRuns / a.playersWindow).toFixed(1) : "—"
            }
          />
          <Stat
            label="returning players"
            value={a.returningPlayers.toLocaleString()}
            hint={
              a.playersWindow
                ? `${((a.returningPlayers / a.playersWindow) * 100).toFixed(0)}% came back`
                : undefined
            }
          />
          <Stat label="players today" value={a.playersToday.toLocaleString()} />
          <Stat
            label="avg runs / player today"
            value={
              a.playersToday ? (runsToday / a.playersToday).toFixed(1) : "—"
            }
          />
          <Stat
            label="𝕏 connections (all-time)"
            value={a.xConnected.toLocaleString()}
          />
        </div>
      </Section>

      <Section title={`Map popularity — last ${MAP_WINDOW_DAYS} days`}>
        <MapBars rows={a.mapCounts} />
      </Section>

      <Section title="Engagement today">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat label="outbound clicks" value={a.clicksToday.toLocaleString()} />
          <Stat
            label="champion clicks"
            value={a.showcaseToday.toLocaleString()}
          />
          <Stat label="chat messages" value={a.chatToday.toLocaleString()} />
          <Stat label="PH boosts claimed" value={a.phToday.toLocaleString()} />
          <Stat
            label="runs / visitor online"
            value={online ? (runsToday / online).toFixed(1) : "—"}
          />
        </div>
      </Section>

      <Section title="Sponsors & money">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat
            label="revenue (paid slots)"
            value={`$${(a.sponsorRevenueCents / 100).toLocaleString()}`}
          />
          <Stat
            label="pending review"
            value={`$${(a.sponsorPendingCents / 100).toLocaleString()}`}
          />
          <Stat label="live slots" value={`${a.sponsorLive}/10`} />
          <Stat
            label="sponsor clicks"
            value={a.sponsorClicks.toLocaleString()}
          />
        </div>
      </Section>

      <Section title="Hall of fame">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="champions" value={a.champions.toLocaleString()} />
          <Stat label="best score ever" value={a.bestEver.toLocaleString()} />
          <Stat
            label="avg champion score"
            value={a.avgChampion.toLocaleString()}
          />
          <Stat
            label="clicks sent (all-time)"
            value={a.championClicks.toLocaleString()}
          />
        </div>
      </Section>

      <Section title="Traffic">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat label="online" value={online.toLocaleString()} />
          <Stat label="visitors" value={total.toLocaleString()} />
          <Stat label="runs today" value={runsToday.toLocaleString()} />
        </div>
      </Section>
    </>
  );
}

function SponsorsTab({ sponsors }: { sponsors: SponsorRow[] }) {
  return (
    <Section title="Sponsors">
      {sponsors.length === 0 ? (
        <p className="text-lg text-muted">No sponsor slots sold yet.</p>
      ) : (
        <ul className="space-y-3">
          {sponsors.map((s) => (
            <li key={s.id} className="flex items-start gap-3">
              <div className="min-w-0">
                <p className="text-lg truncate">
                  <a href={s.url} className="underline" rel="nofollow ugc">
                    {s.name}
                  </a>{" "}
                  <span className="text-muted">
                    ${(s.price_cents / 100).toLocaleString()} ·{" "}
                    {s.created_at.slice(0, 10)} · {s.clicks_count} clicks
                  </span>
                </p>
                <p className="text-base text-muted truncate">{s.pitch}</p>
              </div>
              <span
                className={`ml-auto font-pixel text-[8px] uppercase px-1.5 py-0.5 border-2 border-ink ${
                  s.status === "live"
                    ? "bg-gold"
                    : s.status === "pending"
                      ? "bg-paper"
                      : "bg-ink/10"
                }`}
              >
                {s.status}
              </span>
              {s.status !== "live" && (
                <AdminAction
                  label="go live"
                  path="/api/admin/sponsors"
                  body={{ id: s.id, status: "live" }}
                />
              )}
              {s.status === "pending" && (
                <AdminAction
                  label="reject"
                  path="/api/admin/sponsors"
                  body={{ id: s.id, status: "rejected" }}
                  confirmText={`Reject "${s.name}"? They stay paid — refund separately in Stripe.`}
                />
              )}
              {s.status === "live" && (
                <AdminAction
                  label="expire"
                  path="/api/admin/sponsors"
                  body={{ id: s.id, status: "expired" }}
                  confirmText={`Take "${s.name}" off the rails?`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function LogosTab({ bids }: { bids: LogoBidRow[] }) {
  return (
    <Section title="Logo orders">
      {bids.length === 0 ? (
        <p className="text-lg text-muted">No paid logo orders yet.</p>
      ) : (
        <ul className="space-y-3">
          {bids.map((b) => (
            <li key={b.id} className="flex items-start gap-3">
              {/* the uploaded image, straight from the base64 data URL */}
              <span className="w-14 h-14 shrink-0 border-2 border-ink bg-white flex items-center justify-center overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b.logo_data_url}
                  alt={`${b.brand} logo`}
                  className="max-w-full max-h-full"
                />
              </span>
              <div className="min-w-0">
                <p className="text-lg truncate">
                  {b.url ? (
                    <a href={b.url} className="underline" rel="nofollow ugc">
                      {b.brand}
                    </a>
                  ) : (
                    b.brand
                  )}{" "}
                  <span className="text-muted">
                    ${(b.price_cents / 100).toLocaleString()} ·{" "}
                    {b.created_at.slice(0, 10)}
                  </span>
                </p>
                <a
                  href={b.logo_data_url}
                  target="_blank"
                  rel="noopener"
                  className="text-base text-muted underline"
                >
                  open logo full size
                </a>
              </div>
              <span
                className={`ml-auto font-pixel text-[8px] uppercase px-1.5 py-0.5 border-2 border-ink ${
                  b.status === "approved"
                    ? "bg-gold"
                    : b.status === "pending"
                      ? "bg-paper"
                      : "bg-ink/10"
                }`}
              >
                {b.status}
              </span>
              {b.status !== "approved" && (
                <AdminAction
                  label="approve"
                  path="/api/admin/logo"
                  body={{ id: b.id, status: "approved" }}
                />
              )}
              {b.status === "pending" && (
                <AdminAction
                  label="reject"
                  path="/api/admin/logo"
                  body={{ id: b.id, status: "rejected" }}
                  confirmText={`Reject "${b.brand}"? They stay paid — refund separately in Stripe.`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ChatTab({ chat }: { chat: ChatRow[] }) {
  return (
    <Section title="Latest chat">
      {chat.length === 0 ? (
        <p className="text-lg text-muted">Chat is empty.</p>
      ) : (
        <ul className="space-y-2">
          {chat.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2">
              <span className="font-pixel text-[9px] shrink-0">
                {m.x_handle ? `@${m.x_handle}` : m.name}
              </span>
              <span className="text-lg min-w-0 truncate">{m.body}</span>
              <span className="ml-auto text-sm text-muted shrink-0">
                {m.created_at.slice(11, 16)}
              </span>
              <AdminAction
                label="del"
                path="/api/admin/chat"
                method="DELETE"
                body={{ id: m.id }}
                confirmText="Delete this message for everyone?"
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AnnounceTab({ announcements }: { announcements: AnnouncementRow[] }) {
  return (
    <>
      <Section title="Push an announcement">
        <p className="text-lg text-muted mb-4">
          Shows as a modal to every visitor until they dismiss it — once
          dismissed, that browser never sees it again, even if it stays live.
        </p>
        <AdminAnnounceForm />
      </Section>
      <Section title="Announcements">
        {announcements.length === 0 ? (
          <p className="text-lg text-muted">Nothing pushed yet.</p>
        ) : (
          <ul className="space-y-3">
            {announcements.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2">
                <span
                  className={`font-pixel text-[8px] uppercase shrink-0 ${
                    a.active ? "text-orange-deep" : "text-muted"
                  }`}
                >
                  {a.active ? "live" : "unpublished"}
                </span>
                <span className="text-lg min-w-0 truncate">
                  {a.title ? `${a.title} — ` : ""}
                  {a.body}
                </span>
                <span className="ml-auto text-sm text-muted shrink-0">
                  @{a.created_by} · {a.created_at.slice(0, 10)}
                </span>
                <AdminAction
                  label={a.active ? "unpublish" : "republish"}
                  path="/api/admin/announcements"
                  method="PATCH"
                  body={{ id: a.id, active: !a.active }}
                  confirmText={
                    a.active
                      ? "Stop showing this announcement to visitors who haven't dismissed it?"
                      : "Show this announcement again to visitors who haven't dismissed it?"
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function BansTab({ bans }: { bans: BanRow[] }) {
  return (
    <Section title="Recent bans">
      {bans.length === 0 ? (
        <p className="text-lg text-muted">No bans on record.</p>
      ) : (
        <ul className="space-y-2">
          {bans.map((b) => (
            <li key={b.id} className="flex items-baseline gap-2">
              <span className="font-pixel text-[8px] uppercase shrink-0">
                {b.product_id ? "entry" : "device"}
              </span>
              <span className="text-lg min-w-0 truncate">{b.reason}</span>
              <span className="ml-auto text-sm text-muted shrink-0">
                {b.created_at.slice(0, 10)}
              </span>
              <AdminAction
                label="unban"
                path="/api/admin/ban"
                method="DELETE"
                body={{ banId: b.id }}
                confirmText={
                  b.product_id
                    ? "Lift this ban? The entry can compete again."
                    : "Lift this ban? The device can play again (its linked ip/cookie ban lifts too). Runs it got rejected stay rejected."
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const token = (await cookies()).get(X_SESSION_COOKIE)?.value;
  const handle = await xHandleFromToken(token);
  if (!isAdminHandle(handle)) return <Gate handle={handle} />;

  const tab = resolveTab((await searchParams).tab);
  const client = db();
  const today = utcDay();

  // header always; the active tab's data alongside it
  type TabData =
    | { kind: "review"; reviews: PendingReview[] }
    | { kind: "board"; board: Awaited<ReturnType<typeof boardData>> }
    | { kind: "analytics"; analytics: Analytics }
    | { kind: "sponsors"; sponsors: SponsorRow[] }
    | { kind: "logos"; bids: LogoBidRow[] }
    | { kind: "chat"; chat: ChatRow[] }
    | { kind: "announce"; announcements: AnnouncementRow[] }
    | { kind: "bans"; bans: BanRow[] };
  const loadTab = async (): Promise<TabData> => {
    switch (tab) {
      case "review":
        return { kind: tab, reviews: await pendingReviews(client, today) };
      case "board":
        return { kind: tab, board: await boardData(client, today) };
      case "analytics":
        return { kind: tab, analytics: await analyticsData(client, today) };
      case "sponsors":
        return {
          kind: tab,
          sponsors:
            ((
              await client
                .from("sponsors")
                .select(
                  "id, name, pitch, url, status, price_cents, clicks_count, created_at"
                )
                .order("created_at", { ascending: false })
                .limit(50)
            ).data as SponsorRow[]) ?? [],
        };
      case "logos":
        return {
          kind: tab,
          bids:
            ((
              await client
                .from("logo_bids")
                .select(
                  "id, brand, url, logo_data_url, status, price_cents, created_at"
                )
                .in("status", ["pending", "approved", "rejected"])
                .order("created_at", { ascending: false })
                .limit(50)
            ).data as LogoBidRow[]) ?? [],
        };
      case "chat":
        return {
          kind: tab,
          chat:
            ((
              await client
                .from("chat_messages")
                .select("id, name, body, x_handle, created_at")
                .order("id", { ascending: false })
                .limit(50)
            ).data as ChatRow[]) ?? [],
        };
      case "announce":
        return {
          kind: tab,
          announcements:
            ((
              await client
                .from("announcements")
                .select("id, title, body, active, created_by, created_at")
                .order("created_at", { ascending: false })
                .limit(50)
            ).data as AnnouncementRow[]) ?? [],
        };
      case "bans":
        return {
          kind: tab,
          bans:
            ((
              await client
                .from("bans")
                .select("id, product_id, ip_hash, reason, created_at")
                .order("created_at", { ascending: false })
                .limit(50)
            ).data as BanRow[]) ?? [],
        };
    }
  };
  const [head, tabData] = await Promise.all([
    headerData(client, today),
    loadTab(),
  ]);

  const badges: Partial<Record<TabId, number>> = {
    review: head.pendingReviews,
    sponsors: head.pendingSponsors,
    logos: head.pendingLogos,
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-pixel text-xl text-white text-outline leading-relaxed">
          Admin tools
        </h1>
        <p className="text-lg text-muted">
          logged in as <span className="text-orange-deep">@{handle}</span>
        </p>
      </div>

      <div className="pixel-card p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="online now" value={head.online.toLocaleString()} />
          <Stat label="visitors" value={head.total.toLocaleString()} />
          <Stat label="runs today" value={head.runsToday.toLocaleString()} />
          <Stat
            label="cheats today"
            value={head.cheatsToday.toLocaleString()}
          />
        </div>
      </div>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/admin?tab=${t.id}`}
            className={`pixel-btn font-pixel text-[9px] px-3 py-2 ${
              t.id === tab ? "bg-orange text-white" : "bg-paper"
            }`}
          >
            {t.label}
            <Badge n={badges[t.id] ?? 0} />
          </Link>
        ))}
      </nav>

      {tabData.kind === "review" && <ReviewTab reviews={tabData.reviews} />}
      {tabData.kind === "board" && (
        <BoardTab
          board={tabData.board.rows}
          tags={tabData.board.tags}
          today={today}
        />
      )}
      {tabData.kind === "analytics" && (
        <AnalyticsTab
          a={tabData.analytics}
          online={head.online}
          total={head.total}
          runsToday={head.runsToday}
        />
      )}
      {tabData.kind === "sponsors" && (
        <SponsorsTab sponsors={tabData.sponsors} />
      )}
      {tabData.kind === "logos" && <LogosTab bids={tabData.bids} />}
      {tabData.kind === "chat" && <ChatTab chat={tabData.chat} />}
      {tabData.kind === "announce" && (
        <AnnounceTab announcements={tabData.announcements} />
      )}
      {tabData.kind === "bans" && <BansTab bans={tabData.bans} />}
    </div>
  );
}
