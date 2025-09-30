import "./../globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { QueryProvider } from "@/lib/queryClient";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import type { ReactNode } from "react";

/**
 * Light/dark bootstrap:
 * Respect persisted localStorage.theme or prefers-color-scheme without FOUC.
 */
const themeInitScript = `
(() => {
  try {
    const d = document.documentElement;
    const ls = localStorage.getItem("theme");
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const dark = ls ? ls === "dark" : mql.matches;
    d.classList.toggle("dark", dark);
  } catch {}
})();
`;

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" }
  ]
};

export const metadata: Metadata = {
  title: "Bowdoin Marketplace",
  description:
    "A Bowdoin-branded marketplace for the community. Browse, post, and chat."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a href="#main" className="skip-link">Skip to main content</a>

        <QueryProvider>
          <header className="border-b border-border bg-surface">
            <nav
              className="container flex h-14 items-center justify-between"
              aria-label="Primary"
            >
              <Link
                href="/"
                className="text-2xl font-bold text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--focus))]"
                aria-label="Bowdoin Marketplace home"
              >
                Bowdoin <span className="text-accent">Marketplace</span>
              </Link>

              <div className="flex items-center gap-4">
                <Link className="hover:underline" href="/listings/new">
                  Post a listing
                </Link>
                <Link className="hover:underline" href="/messages">
                  Messages
                </Link>
                <ThemeToggle />
              </div>
            </nav>
          </header>

          <main id="main" className="container py-6 min-h-svh">
            {children}
          </main>

          <footer className="border-t border-border py-8 text-sm text-muted-foreground">
            <div className="container">
              © {new Date().getFullYear()} Bowdoin College Community — Unofficial student marketplace.
            </div>
          </footer>
        </QueryProvider>
      </body>
    </html>
  );
}
