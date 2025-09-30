"use client";

import { useCallback } from "react";

export function ThemeToggle() {
  const handleClick = useCallback(() => {
    const root = document.documentElement;
    const isDark = root.classList.toggle("dark");
    try {
      localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
      // ignore persistence issues
    }
  }, []);

  return (
    <button
      type="button"
      className="rounded-md px-3 py-1 border border-border bg-card text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-[hsl(var(--focus))]"
      onClick={handleClick}
      aria-label="Toggle theme"
    >
      Toggle theme
    </button>
  );
}
