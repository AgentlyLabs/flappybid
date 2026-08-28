"use client";

import { useEffect, useState } from "react";

// Header "connect 𝕏" button. Linking is a full-page OAuth round trip through
// /api/x/connect; disconnecting clears the HttpOnly session cookie. The
// linked state is broadcast as a window event so the chat composer updates
// without a reload.

export const X_LINK_EVENT = "fb:x-link";

export default function XConnectButton() {
  const [handle, setHandle] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/x/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHandle(d?.handle ?? null))
      .catch(() => {
        // unknown link state just means the connect button shows
      });
  }, []);

  const disconnect = async () => {
    try {
      await fetch("/api/x/me", { method: "DELETE" });
    } catch {
      // cookie may outlive this attempt; the next tap retries
    }
    setHandle(null);
    window.dispatchEvent(new CustomEvent(X_LINK_EVENT, { detail: null }));
  };

  if (handle) {
    return (
      <span className="flex items-center gap-1.5 normal-case">
        <span
          className="text-orange-deep max-w-[9ch] sm:max-w-none truncate"
          title="your linked X account"
        >
          @{handle}
        </span>
        <button
          onClick={disconnect}
          title="Disconnect your X account"
          aria-label="Disconnect X account"
          className="hover:text-orange-deep cursor-pointer"
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <a
      href="/api/x/connect"
      title="Connect X — chat as your real @handle"
      className="pixel-btn bg-orange text-white px-2.5 py-1.5"
    >
      <span className="hidden sm:inline">connect </span>𝕏
    </a>
  );
}
