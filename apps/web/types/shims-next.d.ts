// Minimal Next typings so `tsc` succeeds when Next’s real types aren’t linked.
// Safe to keep in VCS; the real @types from `next` will override these at build/dev time.

declare module "next/server" {
  // Map Next’s Request type to the standard Fetch Request so code typechecks.
  export type NextRequest = Request;

  // Model NextResponse as a Response subclass with the common static helpers.
  export class NextResponse extends Response {
    static json(data: unknown, init?: ResponseInit): NextResponse;
    static redirect(url: string | URL, status?: number): NextResponse;
    static rewrite(url: string | URL, init?: ResponseInit): NextResponse;
    static next(): NextResponse;
  }
}

declare module "next/navigation" {
  // Enough for client components that only call useSearchParams, etc.
  export function useSearchParams(): URLSearchParams;
  // Add other hooks as needed:
  export function usePathname(): string;
  export function useRouter(): {
    push(href: string): void;
    replace(href: string): void;
    back(): void;
    refresh(): void;
  };
}

declare module "next/app" {
  // Minimal AppProps so pages/_app.tsx typechecks.
  export interface AppProps<P = any> {
    Component: (props: P) => JSX.Element | null;
    pageProps: P;
  }
}
