// Minimal ambient declarations for packages that don't ship TS types.
// This keeps d.ts generation unblocked without pulling in unsafe community types.

declare module "mjml" {
  // mjml exports a default function mjml(input: string, opts?: any): { html: string; errors?: any[]; }
  const mjml: (input: string, opts?: unknown) => { html: string; errors?: unknown[] };
  export default mjml;
}

declare module "mjml-core" {
  // We only need it as an opaque module for dts emission.
  const core: unknown;
  export = core;
}
