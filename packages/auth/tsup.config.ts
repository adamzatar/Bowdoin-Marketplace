import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/nextauth.ts',
    'src/okta-provider.ts',
    'src/rbac.ts',
    'src/rbac/affiliation.ts',
    'src/providers/email.ts',
    'src/utils/email-token-store.ts',
  ],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  tsconfig: 'tsconfig.tsup.json',
});
