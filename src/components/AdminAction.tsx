"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// One button = one admin API call. The dashboard is a server component, so
// after a successful action we just ask the router to re-render it with
// fresh data instead of mirroring state on the client.

export default function AdminAction({
  label,
  path,
  body,
  method = "POST",
  confirmText,
  className = "pixel-btn bg-paper font-pixel text-[8px] px-2 py-1.5",
}: {
  label: string;
  path: string;
  body: Record<string, unknown>;
  method?: "POST" | "PATCH" | "DELETE";
  confirmText?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      window.alert("Action failed — check the server logs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={run}
      disabled={busy}
      className={`${className} disabled:opacity-50 cursor-pointer`}
    >
      {busy ? "…" : label}
    </button>
  );
}
