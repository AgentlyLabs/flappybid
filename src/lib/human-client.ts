"use client";

// Client side of the human check: when /api/run/start answers humanCheck,
// run an invisible Turnstile challenge and trade the token for the
// fb_human day-pass cookie at /api/human. With no site key configured this
// resolves immediately, so the feature is inert until both env vars exist.

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback": () => void;
          appearance?: string;
        }
      ) => string;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null; // a later attempt can retry the load
      reject(new Error("turnstile script failed"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// Solve a challenge and mint the pass. Returns true when the cookie is set
// (or the layer is off) — the caller then retries whatever got refused.
export async function ensureHuman(): Promise<boolean> {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!siteKey) return true;

  try {
    await loadScript();
    // interaction-only: invisible unless Cloudflare decides this browser
    // needs to see a checkbox — so the host element must be on screen
    const host = document.createElement("div");
    host.className = "fixed bottom-4 left-1/2 -translate-x-1/2 z-[60]";
    document.body.appendChild(host);
    let widgetId: string | undefined;
    try {
      const token = await new Promise<string>((resolve, reject) => {
        widgetId = window.turnstile!.render(host, {
          sitekey: siteKey,
          appearance: "interaction-only",
          callback: resolve,
          "error-callback": () => reject(new Error("challenge failed")),
        });
      });
      const res = await fetch("/api/human", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      return res.ok;
    } finally {
      if (widgetId) window.turnstile?.remove(widgetId);
      host.remove();
    }
  } catch {
    return false;
  }
}
