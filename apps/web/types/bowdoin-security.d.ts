// Minimal ambient types for @bowdoin/security sub-exports

declare module '@bowdoin/security/csp' {
  export type CSPDirectiveValue = string[] | true;
  export type BuildCSPOptions = {
    readonly directives: Readonly<Record<string, CSPDirectiveValue>>;
    readonly reportOnly?: boolean;
  };

  // Both overloads supported: object form or flat directives map
  export function buildContentSecurityPolicy(
    input: BuildCSPOptions | Readonly<Record<string, CSPDirectiveValue>>
  ): string;
}

declare module '@bowdoin/security/headers' {
  export function securityHeaders(): Record<string, string>;
  export function createSecurityHeaders(): Record<string, string>;
}