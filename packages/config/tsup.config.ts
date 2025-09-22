// packages/config/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/env.ts', 'src/flags.ts'],
  target: 'es2022',
  format: ['esm', 'cjs'],   // emit both so require.resolve & ESM imports work
  dts: true,                // generate .d.ts for all entries
  sourcemap: true,
  clean: true,
  treeshake: true,
  outDir: 'dist',
  minify: false,
});