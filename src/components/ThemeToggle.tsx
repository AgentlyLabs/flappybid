"use client";

import { useEffect, useState } from "react";

// Day/night switch in the header. Light is the default; the choice sticks in
// localStorage and a pre-paint script in the layout applies it on load.
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  // read the class the pre-paint script set, after hydration
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("fb_theme", next ? "dark" : "light");
    } catch {
      // no storage — the choice just won't survive a reload
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to day mode" : "Switch to night mode"}
      title={dark ? "Day mode" : "Night mode"}
      className="text-sm leading-none hover:text-orange-deep"
    >
      <span aria-hidden>{dark ? "☀️" : "🌙"}</span>
    </button>
  );
}
