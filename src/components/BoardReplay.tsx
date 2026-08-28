"use client";

import { useState } from "react";
import ReplayViewer from "./ReplayViewer";

// "watch" button for an admin board row: fetches the entry's best verified
// run of the day on demand and mounts the ghost viewer inline. Fetch-on-click
// keeps the board section light — 20 rows would otherwise pull 20 replays.

export default function BoardReplay({ productId }: { productId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "open";
        seed: number;
        flapFrames: number[];
        shootFrames: number[];
        map: string;
      }
  >({ kind: "idle" });

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/replay?productId=${productId}`);
      const data = await res.json();
      if (!res.ok) {
        setState({ kind: "error", message: data.error ?? "no replay" });
        return;
      }
      setState({
        kind: "open",
        seed: data.seed,
        flapFrames: data.flapFrames,
        shootFrames: data.shootFrames ?? [],
        map: data.map ?? "classic",
      });
    } catch {
      setState({ kind: "error", message: "network error" });
    }
  };

  if (state.kind === "open") {
    return (
      <div className="w-full mt-2">
        <ReplayViewer
          seed={state.seed}
          flapFrames={state.flapFrames}
          shootFrames={state.shootFrames}
          mapId={state.map}
        />
        <button
          onClick={() => setState({ kind: "idle" })}
          className="pixel-btn bg-paper font-pixel text-[8px] px-3 py-1.5 mt-2"
        >
          close
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={load}
      disabled={state.kind === "loading"}
      className="pixel-btn bg-paper font-pixel text-[8px] px-3 py-1.5 disabled:opacity-50"
    >
      {state.kind === "loading"
        ? "…"
        : state.kind === "error"
          ? state.message
          : "watch"}
    </button>
  );
}
