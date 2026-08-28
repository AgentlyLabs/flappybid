"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Compose form for the admin announce tab. Submitting opens a preview that
// renders the announcement with the exact markup visitors get from
// AnnouncementModal; nothing is published until the admin confirms there.
// Like AdminAction, the dashboard is a server component, so a successful
// publish just refreshes it.

const TITLE_MAX = 80;
const BODY_MAX = 1000;

export default function AdminAnnounceForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Publish failed.");
        return;
      }
      setTitle("");
      setBody("");
      setPreview(false);
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) setPreview(true);
        }}
        className="space-y-3"
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          placeholder="Title (optional)"
          className="w-full border-[3px] border-ink bg-paper px-3 py-2 text-lg outline-none focus:border-orange-deep"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={BODY_MAX}
          rows={4}
          placeholder="What should everyone see?"
          className="w-full border-[3px] border-ink bg-paper px-3 py-2 text-lg outline-none focus:border-orange-deep resize-y"
        />
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={busy || !body.trim()}
            className="pixel-btn bg-orange text-white font-pixel text-[9px] px-4 py-2 disabled:opacity-50"
          >
            preview
          </button>
          <span className="text-sm text-muted">
            {body.length}/{BODY_MAX}
          </span>
          {error && <span className="text-sm text-red">{error}</span>}
        </div>
      </form>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
          onClick={() => setPreview(false)}
        >
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <p className="font-pixel text-[9px] uppercase tracking-wider text-white text-center mb-3">
              preview — what every visitor will see
            </p>
            {/* keep in sync with AnnouncementModal — this IS the pitch */}
            <div className="pixel-panel w-full overflow-hidden">
              <div className="border-b-[3px] border-ink bg-orange px-4 py-2 flex items-center justify-between gap-4">
                <span className="font-pixel text-[9px] uppercase tracking-wider text-white">
                  📢 announcement
                </span>
                <button
                  onClick={() => setPreview(false)}
                  className="font-pixel text-xs text-white hover:text-gold"
                  aria-label="Close preview"
                >
                  X
                </button>
              </div>
              <div className="p-6">
                {title.trim() && (
                  <h2 className="font-pixel text-sm leading-relaxed">
                    {title.trim()}
                  </h2>
                )}
                <p
                  className={`text-xl whitespace-pre-line ${title.trim() ? "mt-3" : ""}`}
                >
                  {body.trim()}
                </p>
                <button
                  onClick={() => setPreview(false)}
                  className="pixel-btn bg-orange text-white text-xs px-8 py-3 mt-5 w-full"
                >
                  OK
                </button>
              </div>
            </div>
            <div className="mt-4 flex justify-center gap-3">
              <button
                onClick={publish}
                disabled={busy}
                className="pixel-btn bg-orange text-white font-pixel text-[9px] px-4 py-2 disabled:opacity-50"
              >
                {busy ? "…" : "publish to everyone"}
              </button>
              <button
                onClick={() => setPreview(false)}
                disabled={busy}
                className="pixel-btn bg-paper font-pixel text-[9px] px-4 py-2 disabled:opacity-50"
              >
                keep editing
              </button>
            </div>
            {error && (
              <p className="mt-2 text-center text-sm text-red">{error}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
