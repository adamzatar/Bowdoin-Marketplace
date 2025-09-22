// packages/db/scripts/backfill-affiliation.mts
/**
 * Backfill user.affiliation based on email domain (Bowdoin vs Community).
 *
 * Rules:
 *  - Emails ending in "@bowdoin.edu" => Affiliation.bowdoin_member
 *  - Everything else => Affiliation.community
 *
 * Safety:
 *  - Defaults to DRY-RUN (no writes) unless --apply (or APPLY=1) is set.
 *  - By default, only users with NULL/UNKNOWN affiliation are targeted.
 *    Use --all to re-evaluate all users.
 *  - Optional --limit N to cap updates.
 *
 * Usage:
 *  pnpm -w ts-node packages/db/scripts/backfill-affiliation.mts --apply --limit 500
 *  APPLY=1 pnpm -w ts-node packages/db/scripts/backfill-affiliation.mts --all
 */

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { PrismaClient, Prisma, Affiliation } from '@prisma/client';

type CliOpts = {
  apply: boolean;
  all: boolean;
  limit?: number;
  batchSize: number;
  sleepMs: number;
};

const prisma = new PrismaClient();

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    apply: process.env.APPLY === '1' || argv.includes('--apply'),
    all: argv.includes('--all'),
    batchSize: 200,
    sleepMs: 25,
  };

  const limitIx = argv.findIndex((a) => a === '--limit');
  if (limitIx !== -1 && argv[limitIx + 1]) {
    const n = Number(argv[limitIx + 1]);
    if (!Number.isNaN(n) && n > 0) opts.limit = n;
  }

  const bsIx = argv.findIndex((a) => a === '--batch');
  if (bsIx !== -1 && argv[bsIx + 1]) {
    const n = Number(argv[bsIx + 1]);
    if (!Number.isNaN(n) && n > 0) opts.batchSize = n;
  }

  const sleepIx = argv.findIndex((a) => a === '--sleep');
  if (sleepIx !== -1 && argv[sleepIx + 1]) {
    const n = Number(argv[sleepIx + 1]);
    if (!Number.isNaN(n) && n >= 0) opts.sleepMs = n;
  }

  return opts;
}

function inferAffiliation(email: string): Affiliation {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (domain === 'bowdoin.edu') return Affiliation.BOWDOIN;
  if (!domain) return Affiliation.COMMUNITY;
  return Affiliation.COMMUNITY;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function selectTargets(opts: CliOpts) {
  const args: Prisma.UserFindManyArgs = {
    select: { id: true, email: true, affiliation: true },
    orderBy: { createdAt: 'asc' },
  };

  if (!opts.all) {
    args.where = { affiliation: Affiliation.COMMUNITY };
  }

  if (typeof opts.limit === 'number') {
    args.take = opts.limit;
  }

  return prisma.user.findMany(args);
}

async function writeAffiliation(
  userId: string,
  newAff: Affiliation,
  oldAff: Affiliation,
  email: string,
  apply: boolean,
) {
  if (!apply) return;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { affiliation: newAff, updatedAt: new Date() },
    });

    const auditData: Prisma.JsonObject = {
      from: oldAff,
      to: newAff,
      reason: 'domain_inference',
      email,
    };

    await tx.auditLog.create({
      data: {
        action: 'affiliation.backfill',
        entityType: 'User',
        entityId: userId,
        actorUserId: userId,
        metadata: auditData,
      },
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = await selectTargets(opts);

  globalThis.console?.log?.(
    `[affiliation/backfill] candidates=${targets.length} apply=${opts.apply} all=${opts.all} limit=${opts.limit ?? '∞'} batch=${opts.batchSize} sleep=${opts.sleepMs}ms`,
  );

  let updated = 0;
  let skipped = 0;

  const batches = chunk(targets, opts.batchSize);
  for (const [bi, batch] of batches.entries()) {
    globalThis.console?.log?.(
      `[affiliation/backfill] processing batch ${bi + 1}/${batches.length} size=${batch.length}`,
    );

    for (const u of batch) {
      const email = u.email;
      if (!email) {
        skipped++;
        continue;
      }
      const inferred = inferAffiliation(email);

      if (!opts.all && u.affiliation !== Affiliation.COMMUNITY) {
        skipped++;
        continue;
      }

      if (u.affiliation === inferred) {
        skipped++;
        continue;
      }

      globalThis.console?.log?.(
        `[affiliation/backfill] user=${u.id} email=${email} from=${u.affiliation ?? 'null'} -> ${inferred}${opts.apply ? '' : ' (dry-run)'}`,
      );

      await writeAffiliation(u.id, inferred, u.affiliation, email, opts.apply);
      updated++;
    }

    if (opts.sleepMs > 0 && bi < batches.length - 1) {
      await delay(opts.sleepMs);
    }
  }

  globalThis.console?.log?.(
    `[affiliation/backfill] done candidates=${targets.length} updated=${updated} skipped=${skipped} apply=${opts.apply}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      globalThis.console?.error?.('[affiliation/backfill] ERROR', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
