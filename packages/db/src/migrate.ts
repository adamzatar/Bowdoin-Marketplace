// packages/db/src/migrate.ts
/**
 * Bowdoin Marketplace — Prisma migration runner
 *
 * Safe, production-minded wrapper over Prisma CLI for:
 *  - deploy:  prisma migrate deploy     (production-safe)
 *  - status:  prisma migrate status     (introspection only)
 *  - generate:prisma generate           (generate client)
 *  - reset:   prisma migrate reset      (DEV ONLY unless FORCE=1)
 *  - push:    prisma db push            (DEV ONLY unless FORCE=1)
 *
 * Usage:
 *   pnpm --filter @bowdoin/db exec ts-node src/migrate.ts deploy
 *   pnpm --filter @bowdoin/db exec ts-node src/migrate.ts status
 *   pnpm --filter @bowdoin/db exec ts-node src/migrate.ts generate
 *   pnpm --filter @bowdoin/db exec ts-node src/migrate.ts reset
 *   pnpm --filter @bowdoin/db exec ts-node src/migrate.ts push
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { env } from '@bowdoin/config/env';
import { logger } from '@bowdoin/observability/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure we run prisma relative to this package so it picks up prisma/schema.prisma
const DB_PKG_DIR = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(DB_PKG_DIR, 'prisma', 'schema.prisma');

type Command = 'deploy' | 'status' | 'generate' | 'reset' | 'push';

const isProd = env.NODE_ENV === 'production';
const FORCE = process.env.FORCE === '1';

function ensureDatabaseUrl() {
  if (!env.DATABASE_URL) {
    const msg =
      'DATABASE_URL is not set. Aborting. Provide a valid Postgres connection string in env.';
    logger.error({ msg });
    process.stderr.write(`${msg}\n`);
    process.exit(2);
  }
}

function forbidInProdUnlessForced(cmd: Command) {
  if (isProd && (cmd === 'reset' || cmd === 'push') && !FORCE) {
    const msg = `Refusing to run '${cmd}' in production. Set FORCE=1 if you really intend to do this.`;
    logger.error({ msg, cmd, isProd, FORCE });
    process.stderr.write(`${msg}\n`);
    process.exit(3);
  }
}

function runPrisma(args: string[]): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', 'prisma', ...args, '--schema', PRISMA_SCHEMA],
      {
        cwd: DB_PKG_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: env.DATABASE_URL,
          NODE_ENV: env.NODE_ENV,
        },
      },
    );

    child.on('close', (code) => {
      resolveExit(code ?? 1);
    });
  });
}

async function main() {
  const [, , rawCmd] = process.argv;
  const cmd = (rawCmd as Command) || 'status';

  ensureDatabaseUrl();

  switch (cmd) {
    case 'deploy': {
      logger.info({ msg: 'Applying pending migrations (prisma migrate deploy)…', schema: PRISMA_SCHEMA });
      const code = await runPrisma(['migrate', 'deploy']);
      if (code !== 0) process.exit(code);
      logger.info({ msg: 'Migrations deployed successfully.' });
      break;
    }

    case 'status': {
      logger.info({ msg: 'Checking migration status (prisma migrate status)…' });
      const code = await runPrisma(['migrate', 'status']);
      if (code !== 0) process.exit(code);
      break;
    }

    case 'generate': {
      logger.info({ msg: 'Generating Prisma client (prisma generate)…' });
      const code = await runPrisma(['generate']);
      if (code !== 0) process.exit(code);
      logger.info({ msg: 'Prisma client generated.' });
      break;
    }

    case 'reset': {
      forbidInProdUnlessForced(cmd);
      logger.warn({
        msg: 'RESETTING DATABASE (prisma migrate reset)… This WILL DROP all data.',
        FORCE,
      });
      const args = ['migrate', 'reset', '--force'];
      // Allow running seed after reset if you want: remove --skip-seed to enable seeding script
      if (process.env.SKIP_SEED === '1') args.push('--skip-seed');
      const code = await runPrisma(args);
      if (code !== 0) process.exit(code);
      logger.info({ msg: 'Database reset complete.' });
      break;
    }

    case 'push': {
      forbidInProdUnlessForced(cmd);
      logger.warn({
        msg: 'Applying schema changes with prisma db push (DEV ONLY). Prefer migrations for prod.',
        FORCE,
      });
      const code = await runPrisma(['db', 'push']);
      if (code !== 0) process.exit(code);
      logger.info({ msg: 'db push completed.' });
      break;
    }

    default: {
      const msg =
        `Unknown command: ${rawCmd}\n` +
        `Usage: ts-node src/migrate.ts <deploy|status|generate|reset|push>`;
      logger.error({ msg, rawCmd });
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  logger.error({ msg: 'Migration runner crashed', err });
  process.stderr.write(`Migration error: ${(err as Error).message}\n`);
  process.exit(1);
});