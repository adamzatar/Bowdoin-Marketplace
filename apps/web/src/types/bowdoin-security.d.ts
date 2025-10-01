// Minimal fallbacks so ESLint/TS can resolve subpath imports at dev time.
// The built package provides real .d.ts; these are only used if those aren't present.
declare module '@bowdoin/security/csp' {
  export type CSPDirectiveValue = string[] | true;
  export type BuildCSPOptions = {
    directives: Readonly<Record<string, CSPDirectiveValue>>;
    reportOnly?: boolean;
  };
  export function buildContentSecurityPolicy(
    input: BuildCSPOptions | Readonly<Record<string, CSPDirectiveValue>>
  ): string | { directives: Readonly<Record<string, CSPDirectiveValue>> };
}

declare module '@bowdoin/security/headers' {
  export function securityHeaders(): Record<string, string>;
  export function createSecurityHeaders(): Record<string, string>;
}
