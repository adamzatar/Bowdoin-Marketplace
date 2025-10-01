// packages/email/tsup.config.ts
import { defineConfig } from 'tsup';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve equivalent of __dirname in ESM/TS config.
 */
const DIR = dirname(fileURLToPath(import.meta.url));

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Robust directory copy that:
 * - no-ops if src doesn't exist
 * - creates dest tree
 * - never throws on remove/copy races
 */
async function copyDirSafe(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) return;
  // ensure dest exists
  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirSafe(s, d);
    } else {
      // copy file; if a previous build left something weird, overwrite safely
      await fs.copyFile(s, d).catch(async () => {
        // last-resort: remove then copy
        await fs.rm(d, { force: true }).catch(() => {});
        await fs.copyFile(s, d);
      });
    }
  }
}

/**
 * Post-build copier used by both builds below.
 */
async function copyTemplates(outputDir: string) {
  const src = join(DIR, 'src', 'templates');
  const dst = join(DIR, outputDir, 'templates');
  await copyDirSafe(src, dst);
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
