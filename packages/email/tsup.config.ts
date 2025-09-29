import { existsSync } from 'node:fs';
import { cp as cpAsync, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { defineConfig } from 'tsup';

async function copyTemplates(outputDir: string) {
  const src = join(__dirname, 'src', 'templates');
  const dst = join(__dirname, outputDir, 'templates');
  if (!existsSync(src)) return;
  await mkdir(dst, { recursive: true });
  await cpAsync(src, dst, { recursive: true });
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    target: 'es2022',
    format: ['esm', 'cjs'],
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false,
    platform: 'node',
    treeshake: true,
    minify: false,
    shims: false,
    async onSuccess() {
      await copyTemplates('dist');
    },
  },
  {
    entry: { sendVerificationEmail: 'src/sendVerificationEmail.ts' },
    outDir: 'dist',
    target: 'es2022',
    format: ['esm'],
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false,
    platform: 'node',
    treeshake: true,
    minify: false,
    shims: false,
    async onSuccess() {
      await copyTemplates('dist');
    },
  },
]);
