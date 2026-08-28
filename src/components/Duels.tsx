"use client";

// The duel arena, in three tabs: matchmaking (create/join/spar), ringside
// (live fights to watch), and the daily duel board (+1 per PvP win, -1 per
// loss, floored at zero, keyed to verified X handles). The ws hub owns the
// fights; this page polls the
// door list and the board. Yesterday's top duelist reigns in the showcase
// strip above (DuelChampionBanner, server-rendered by the page) until the
// next close, then retires into the hall forever.

import { useCallback, useEffect, useState } from "react";
import { WEAPONS } from "@/game/arena";
import { productIcon } from "@/lib/normalize";
import ArenaModal, { stashedPit, type ArenaEntry } from "./ArenaModal";
import DuelCloseCountdown from "./DuelCloseCountdown";
import Favicon from "./Favicon";

interface OpenPit {
  code: string;
  host: string;
  options: { noFood: boolean; noSpec: boolean; weapons?: number[]; wager?: number };
  createdAt: number;
}
interface LiveFight {
  code: string;
  names: [string, string];
  watchers: number;
}
interface DuelBoardEntry {
  rank: number;
  handle: string;
  score: number;
  wins: number;
  losses: number;
  refLink: string | null;
  clicks: number;
}
interface DuelChampion {
  date: string;
  handle: string;
  score: number;
  refLink: string | null;
}
interface DuelBoardData {
  day: string;
  entries: DuelBoardEntry[];
  hall: DuelChampion[];
}

type Tab = "fight" | "watch" | "board";

/** what a ref link reads as on the board — the URL, minus the noise */
function refLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** the row's favicon, the same proxy the main board uses: a ref link shows
 *  its site's favicon, a bare handle shows the duelist's X avatar */
function duelIcon(handle: string, refLink: string | null): string {
  if (refLink) {
    try {
      const host = new URL(refLink).hostname.replace(/^www\./, "");
      if (host.includes(".")) return productIcon("url", host);
    } catch {
      // unparseable link — fall through to the avatar
    }
  }
  return productIcon("handle", `@${handle}`);
}

/** a board name: the duelist's ref link if they set one, else @handle. Both
 *  route through /out/duel/:handle so the click is counted and lands on the
 *  ref link (or the X profile) with utm — exactly like the main board's rows. */
function DuelistLink({
  handle,
  refLink,
  className = "font-pixel text-[11px] hover:text-orange-deep",
}: {
  handle: string;
  refLink: string | null;
  className?: string;
}) {
  return (
    <a
      href={`/out/duel/${encodeURIComponent(handle)}`}
      target="_blank"
      rel={refLink ? "noopener nofollow" : "noopener"}
      className={className}
    >
      {refLink ? refLabel(refLink) : `@${handle}`}
    </a>
  );
}

function pitChips(o: OpenPit["options"]): string[] {
  const chips: string[] = [];
  // a wager is the headline term — coins on the line, winner takes the pot
  if (o.wager && o.wager > 0) chips.push(`🪙 ${o.wager} — winner takes ${o.wager * 2}`);
  const skill = [!o.noFood && "food", !o.noSpec && "specs"].filter(
    Boolean
  ) as string[];
  chips.push(skill.length ? `skill duel: ${skill.join("/")}` : "no food · no spec");
  // a trimmed rack is a headline term too — "whip + dds only"
  if (o.weapons && o.weapons.length < WEAPONS.length) {
    chips.push(
      `${o.weapons.map((i) => WEAPONS[i]?.key).filter(Boolean).join(" + ")} only`
    );
  }
  return chips;
}

export default function Duels({ initialJoin }: { initialJoin?: string }) {
  const [tab, setTab] = useState<Tab>("board");
  const [open, setOpen] = useState<OpenPit[]>([]);
  const [fights, setFights] = useState<LiveFight[]>([]);
  const [arenaLive, setArenaLive] = useState<boolean | null>(null);
  const [board, setBoard] = useState<DuelBoardData | null>(null);
  // null = still checking; "" = checked, not linked
  const [xHandle, setXHandle] = useState<string | null>(null);
  // the ref link form: draft input, what the server has, and a status line
  const [refUrl, setRefUrl] = useState("");
  const [refSaved, setRefSaved] = useState<string | null>(null);
  const [refMsg, setRefMsg] = useState("");
  const [refBusy, setRefBusy] = useState(false);
  // the "edit my listing" modal — only reachable from your own board row,
  // and the server only lets the authenticated X owner change it
  const [editingRef, setEditingRef] = useState(false);
  // a challenge link (/duels/ABCD) lands with the join flow already open
  const [arena, setArena] = useState<ArenaEntry | null>(
    initialJoin ? { kind: "join", code: initialJoin } : null
  );

  // a refresh (or a wander to another page) killed the socket, not the pit —
  // the hub holds our seat, the stash knows the way back. an explicit
  // challenge link outranks it. effect (not initial state): sessionStorage
  // doesn't exist during SSR and the markup must match
  useEffect(() => {
    if (initialJoin) return;
    const code = stashedPit();
    // one-shot init from sessionStorage — not a render-loop hazard
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (code) setArena((a) => a ?? { kind: "rejoin", code });
  }, [initialJoin]);

  const refreshPits = useCallback(async () => {
    try {
      const res = await fetch("/api/arena/pits");
      if (!res.ok) return;
      const data = await res.json();
      setArenaLive(data.live === true);
      setOpen(data.open ?? []);
      setFights(data.fights ?? []);
    } catch {
      // keep the last board we saw
    }
  }, []);

  const refreshBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/duels/leaderboard");
      if (res.ok) setBoard(await res.json());
    } catch {
      // keep the last standings we saw
    }
  }, []);

  useEffect(() => {
    const g = setTimeout(() => {
      refreshPits();
      refreshBoard();
    }, 0);
    const t = setInterval(refreshPits, 5_000);
    const b = setInterval(refreshBoard, 30_000);
    fetch("/api/x/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setXHandle(typeof d?.handle === "string" && d.handle ? d.handle : ""))
      .catch(() => setXHandle(""));
    return () => {
      clearTimeout(g);
      clearInterval(t);
      clearInterval(b);
    };
  }, [refreshPits, refreshBoard]);

  const linked = !!xHandle;

  // is this board row the signed-in owner? only they get the edit button
  const isMe = useCallback(
    (handle: string) =>
      linked && handle.toLowerCase() === (xHandle as string).toLowerCase(),
    [linked, xHandle]
  );

  // pull the stored ref link once the X check lands — the form starts
  // prefilled so "edit" and "set" are the same motion
  useEffect(() => {
    if (!linked) return;
    fetch("/api/duel/reflink")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (typeof d?.url === "string" && d.url) {
          setRefSaved(d.url);
          setRefUrl(d.url);
        }
      })
      .catch(() => {});
  }, [linked]);

  const saveRef = useCallback(async () => {
    setRefBusy(true);
    setRefMsg("");
    try {
      const res = await fetch("/api/duel/reflink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: refUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefMsg(data.error ?? "could not save the link");
      } else {
        setRefSaved(data.url);
        setRefUrl(data.url);
        setRefMsg("saved — the board shows your link now");
        refreshBoard();
      }
    } catch {
      setRefMsg("could not save the link");
    } finally {
      setRefBusy(false);
    }
  }, [refUrl, refreshBoard]);

  const clearRef = useCallback(async () => {
    setRefBusy(true);
    setRefMsg("");
    try {
      const res = await fetch("/api/duel/reflink", { method: "DELETE" });
      if (res.ok) {
        setRefSaved(null);
        setRefUrl("");
        setRefMsg("cleared — back to your @handle");
        refreshBoard();
      } else {
        setRefMsg("could not clear the link");
      }
    } catch {
      setRefMsg("could not clear the link");
    } finally {
      setRefBusy(false);
    }
  }, [refreshBoard]);

  return (
    // sponsor rails render globally from the root layout (SponsorRails)
    <div className="w-full px-4 py-6">
      <div className="max-w-2xl w-full mx-auto">
        <div className="text-center mb-5">
          <h1 className="font-pixel text-2xl text-gold text-outline">The Duel Arena</h1>
          <p className="mt-3 max-w-2xl mx-auto text-lg text-muted">
            Duel other birds. Win <span className="text-gold">+1</span> on the
            board, lose −1. Stake coins or keep it friendly.
          </p>
          {arenaLive === false && (
            <p className="text-base text-red mt-3">
              the live arena isn&apos;t running — restart the dev server{" "}
              <code>(npm run dev)</code>
            </p>
          )}
        </div>

        <div className="flex gap-2 mb-6">
          {(
            [
              ["board", "👑 LEADERBOARD"],
              ["fight", `⚔ MATCHMAKING${open.length ? ` (${open.length})` : ""}`],
              ["watch", `👁 LIVE${fights.length ? ` (${fights.length})` : ""}`],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`pixel-btn font-pixel text-[9px] px-3 py-3 flex-1 ${
                tab === key ? "bg-gold" : "bg-paper"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "fight" && (
          <>
            {xHandle === "" && (
              <div className="pixel-card px-4 py-4 text-center mb-6">
                <p className="text-lg text-muted mb-3">
                  duels are 𝕏-verified — one account, one bird on the board.
                  spectating and the pit bot are open to everyone.
                </p>
                <a
                  href={`/api/x/connect?next=${encodeURIComponent("/duels")}`}
                  className="pixel-btn bg-ink text-paper font-pixel text-[10px] px-5 py-3 inline-block"
                >
                  𝕏 CONNECT TO FIGHT
                </a>
              </div>
            )}
            {linked && (
              <p className="text-center text-base text-muted mb-4">
                𝕏 verified — you fight as{" "}
                <span className="font-pixel text-[10px]">@{xHandle}</span>
              </p>
            )}
            {/* the wager pitch — coins are the headline term of a duel, so
                say it out loud before the create button, not just inside the
                pit's stake picker */}
            <div className="pixel-panel bg-gold px-4 py-3 text-center mb-5">
              <p className="font-pixel text-[10px] mb-1.5">
                🪙 duels play for coins
              </p>
              <p className="text-base text-ink/80">
                set a stake when you create a duel — both fighters match it and
                the winner takes the whole pot. no coins? open a friendly and
                just fight for the board.
              </p>
            </div>

            <div className="flex flex-wrap justify-center gap-2 mb-8">
              <button
                onClick={() => setArena({ kind: "create" })}
                disabled={!linked}
                className="pixel-btn bg-orange text-white font-pixel text-[11px] px-5 py-3 disabled:opacity-40"
              >
                ⚔ CREATE A DUEL · 🪙 STAKE
              </button>
              <button
                onClick={() => setArena({ kind: "bot" })}
                className="pixel-btn bg-gold font-pixel text-[11px] px-5 py-3"
              >
                🥊 FIGHT THE BOT
              </button>
              <button
                onClick={() => setArena({ kind: "join" })}
                disabled={!linked}
                className="pixel-btn bg-paper font-pixel text-[10px] px-4 py-3 disabled:opacity-40"
              >
                JOIN BY CODE
              </button>
            </div>

            <h2 className="font-pixel text-sm mb-3">open pits — join a duel</h2>
            {open.length === 0 ? (
              <div className="pixel-card px-4 py-4 text-center text-lg text-muted mb-8">
                nobody&apos;s waiting — create a duel, name your coin stake, and
                take challengers.
              </div>
            ) : (
              <div className="pixel-card divide-y-2 divide-ink/15 mb-8">
                {open.map((p) => (
                  <div key={p.code} className="flex items-center justify-between gap-3 px-4 py-2">
                    <p className="text-lg min-w-0 truncate">
                      <span className="font-pixel text-[11px]">{p.host}</span>
                      <span className="text-muted"> is waiting · {pitChips(p.options).join(" · ")}</span>
                    </p>
                    <button
                      onClick={() => setArena({ kind: "join", code: p.code })}
                      disabled={!linked}
                      className="pixel-btn bg-orange text-white font-pixel text-[9px] px-3 py-2 shrink-0 disabled:opacity-40"
                    >
                      ⚔ FIGHT
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "watch" && (
          <>
            <h2 className="font-pixel text-sm mb-3">live fights — watch from ringside</h2>
            {fights.length === 0 ? (
              <div className="pixel-card px-4 py-4 text-center text-lg text-muted mb-8">
                the pit is quiet. someone should change that.
              </div>
            ) : (
              <div className="pixel-card divide-y-2 divide-ink/15 mb-8">
                {fights.map((f) => (
                  <div key={f.code} className="flex items-center justify-between gap-3 px-4 py-2">
                    <p className="text-lg min-w-0 truncate">
                      <span className="font-pixel text-[11px]">
                        {f.names[0]} vs {f.names[1]}
                      </span>
                      <span className="text-muted">
                        {" "}
                        — LIVE{f.watchers > 0 ? ` · ${f.watchers} watching` : ""}
                      </span>
                    </p>
                    <button
                      onClick={() => setArena({ kind: "spectate", code: f.code })}
                      className="pixel-btn bg-paper font-pixel text-[9px] px-3 py-2 shrink-0"
                    >
                      👁 WATCH
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-base text-muted text-center">
              ringside is free — no 𝕏 account needed to watch.
            </p>
          </>
        )}

        {tab === "board" && (
          <>
            {!board ? (
              <div className="text-center py-16 text-xl mb-8">
                loading today&apos;s board…
              </div>
            ) : board.entries.length === 0 ? (
              <div className="text-center py-16 border-[3px] border-dashed border-ink/50 mb-8">
                <p className="font-pixel text-xs leading-relaxed">
                  No fights on the board yet.
                </p>
                <p className="text-xl mt-3">
                  the first KO of the day starts it. that could be you.
                </p>
              </div>
            ) : (
              <section className="flex flex-col gap-3 mb-8">
                <p className="text-center font-pixel text-[8px] uppercase text-muted">
                  {board.entries.length} duelist
                  {board.entries.length === 1 ? "" : "s"} on the board today
                </p>
                {board.entries.map((e) => {
                  if (e.rank === 1) {
                    return (
                      <div className="pixel-panel bg-gold overflow-hidden" key={e.handle}>
                        <div className="border-b-[3px] border-ink bg-orange px-3 py-1.5 text-center">
                          <span className="font-pixel text-[8px] uppercase tracking-wider text-white">
                            👑 today&apos;s top duelist 👑
                          </span>
                        </div>
                        <div className="flex items-center gap-3 sm:gap-4 px-3.5 sm:px-5 py-5">
                          <div className="w-10 h-10 sm:w-12 sm:h-12 border-[3px] border-ink bg-orange text-white flex items-center justify-center text-xl sm:text-2xl shrink-0">
                            👑
                          </div>
                          <span className="icon-frame w-10 h-10 sm:w-12 sm:h-12 block border-[3px] shrink-0">
                            <Favicon
                              src={duelIcon(e.handle, e.refLink)}
                              alt={e.refLink ? refLabel(e.refLink) : `@${e.handle}`}
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <DuelistLink
                              handle={e.handle}
                              refLink={e.refLink}
                              className="font-pixel text-xs sm:text-sm break-words hover:text-orange-deep block leading-relaxed"
                            />
                            <p className="text-lg mt-1.5">
                              {e.wins} win{e.wins === 1 ? "" : "s"} · {e.losses}{" "}
                              loss{e.losses === 1 ? "" : "es"}
                              {e.clicks > 0 &&
                                ` · ${e.clicks.toLocaleString()} click${e.clicks === 1 ? "" : "s"}`}
                            </p>
                            {isMe(e.handle) && (
                              <button
                                onClick={() => setEditingRef(true)}
                                className="pixel-btn bg-paper font-pixel text-[8px] px-2 py-1.5 mt-2 inline-block"
                              >
                                ✎ EDIT LISTING
                              </button>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-pixel text-2xl sm:text-3xl text-white text-outline">
                              {e.score}
                            </p>
                            <p className="font-pixel text-[8px] uppercase mt-1">
                              pt{e.score === 1 ? "" : "s"}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const medal =
                    e.rank === 2
                      ? { emoji: "🥈", label: "2nd place", chip: "bg-silver" }
                      : e.rank === 3
                        ? { emoji: "🥉", label: "3rd place", chip: "bg-bronze text-white" }
                        : null;

                  return (
                    <div
                      key={e.handle}
                      className={`flex items-center gap-2.5 sm:gap-4 pixel-card px-3 sm:px-4 ${
                        medal ? "py-3" : "py-2.5"
                      }`}
                    >
                      <div
                        className={
                          medal
                            ? `w-9 h-9 border-[3px] border-ink ${medal.chip} flex items-center justify-center text-base shrink-0`
                            : "w-9 h-9 border-[3px] border-ink bg-sand flex items-center justify-center font-pixel text-[10px] shrink-0"
                        }
                      >
                        {medal ? medal.emoji : e.rank}
                      </div>
                      <span className="icon-frame w-9 h-9 block">
                        <Favicon
                          src={duelIcon(e.handle, e.refLink)}
                          alt={e.refLink ? refLabel(e.refLink) : `@${e.handle}`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <DuelistLink
                            handle={e.handle}
                            refLink={e.refLink}
                            className="font-pixel text-[10px] sm:text-[11px] whitespace-nowrap overflow-hidden text-ellipsis hover:text-orange-deep block leading-relaxed"
                          />
                          {medal && (
                            <span
                              className={`font-pixel text-[7px] uppercase px-1.5 py-1 border-2 border-ink shrink-0 hidden sm:inline-block ${medal.chip}`}
                            >
                              {medal.label}
                            </span>
                          )}
                        </div>
                        <p className="text-base mt-1">
                          {e.wins} win{e.wins === 1 ? "" : "s"} · {e.losses}{" "}
                          loss{e.losses === 1 ? "" : "es"}
                          {e.clicks > 0 &&
                            ` · ${e.clicks.toLocaleString()} click${e.clicks === 1 ? "" : "s"}`}
                        </p>
                        {isMe(e.handle) && (
                          <button
                            onClick={() => setEditingRef(true)}
                            className="pixel-btn bg-paper font-pixel text-[8px] px-2 py-1 mt-1.5 inline-block"
                          >
                            ✎ EDIT LISTING
                          </button>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-pixel text-base sm:text-lg">{e.score}</p>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
            <p className="text-base text-muted text-center mb-8">
              the board closes in{" "}
              <DuelCloseCountdown className="font-pixel text-[13px] text-ink tabular-nums align-middle" />{" "}
              — the top duelist takes the crown, wears the banner for a day, and
              retires undefeated.
            </p>

            {board && board.hall.length > 0 && (
              <>
                <h2 className="font-pixel text-sm mb-3">retired duel champions</h2>
                <div className="pixel-card divide-y-2 divide-ink/15 mb-8">
                  {board.hall.map((c) => (
                    <div
                      key={c.date}
                      className="flex items-center justify-between gap-3 px-4 py-2"
                    >
                      <p className="text-lg min-w-0 truncate">
                        <span aria-hidden>👑</span>{" "}
                        <DuelistLink handle={c.handle} refLink={c.refLink} />
                        <span className="text-muted"> · {c.date}</span>
                      </p>
                      <span className="font-pixel text-[11px] shrink-0">
                        {c.score} pt{c.score === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <p className="text-base text-muted text-center mt-8">
          every fight runs on the server, tick by tick, and re-simulates
          bit-exact from its audit log. every weapon averages the same
          damage — your pick is variance, never an edge.
        </p>
      </div>

      {arena && <ArenaModal entry={arena} onClose={() => setArena(null)} />}

      {editingRef && linked && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 px-4"
          onClick={() => setEditingRef(false)}
        >
          <div
            className="pixel-card bg-paper w-full max-w-md px-5 py-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-pixel text-[11px]">edit your listing</h3>
              <button
                onClick={() => setEditingRef(false)}
                className="font-pixel text-[11px] px-1"
                aria-label="close"
              >
                ✕
              </button>
            </div>
            <p className="text-base text-muted mb-3">
              shown on the board instead of @{xHandle}. your fights still score
              under your 𝕏 handle — this only changes the name the board shows
              and where it points.
            </p>
            <div className="flex gap-2">
              <input
                value={refUrl}
                onChange={(e) => setRefUrl(e.target.value)}
                placeholder="https://your-link.example/ref"
                maxLength={200}
                className="flex-1 min-w-0 border-2 border-ink bg-paper px-2 py-1.5 text-lg outline-none focus:border-orange-deep"
              />
              <button
                onClick={saveRef}
                disabled={refBusy || !refUrl.trim()}
                className="pixel-btn bg-gold font-pixel text-[9px] px-3 py-2 shrink-0 disabled:opacity-40"
              >
                SAVE
              </button>
              {refSaved && (
                <button
                  onClick={clearRef}
                  disabled={refBusy}
                  className="pixel-btn bg-paper font-pixel text-[9px] px-3 py-2 shrink-0 disabled:opacity-40"
                >
                  CLEAR
                </button>
              )}
            </div>
            {refMsg && <p className="text-base text-muted mt-2">{refMsg}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
