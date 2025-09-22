import { existsSync } from 'node:fs';
import { cp as cpAsync, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/sendVerificationEmail.ts'],
  format: ['esm'],
  target: 'es2022',
  sourcemap: true,
  dts: false,
  clean: true,
  async onSuccess() {
    const src = join(__dirname, 'src', 'templates');
    const dst = join(__dirname, 'dist', 'templates');
    try {
      if (existsSync(src)) {
        await mkdir(dst, { recursive: true });
        await cpAsync(src, dst, { recursive: true });
      }
    } catch {
      // best-effort copy
    }
  },
});
