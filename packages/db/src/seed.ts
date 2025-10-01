/**
 * Bowdoin Marketplace — Database Seed Script
 *
 * Seeds development data into the database.
 * Safe to run multiple times (idempotent where possible).
 */

import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { logger } from '@bowdoin/observability/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seed() {
  logger.info('🌱 Starting database seeding...');

  // ---------------------------------------------------------------------------
  // Example Users (keep to required fields; let DB defaults fill the rest)
  // ---------------------------------------------------------------------------

  const adminEmail = 'admin@bowdoin.edu';
  const communityEmail = 'dev@example.com';

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      id: randomUUID(),
      email: adminEmail,
      name: 'Admin User',
      // role/affiliation/status omitted to avoid enum mismatch; defaults apply
    },
  });

  const communityUser = await prisma.user.upsert({
    where: { email: communityEmail },
    update: {},
    create: {
      id: randomUUID(),
      email: communityEmail,
      name: 'Community Tester',
      // omit affiliation/role/verification fields unless your schema defines them
    },
  });

  logger.info(
    { adminId: adminUser.id, communityId: communityUser.id },
    '✅ Seeded users'
  );

  // ---------------------------------------------------------------------------
  // Example Listings (omit enum fields so schema defaults apply; use numbers for price)
  // ---------------------------------------------------------------------------

  await prisma.listing.createMany({
    skipDuplicates: true,
    data: [
      {
        id: randomUUID(),
        title: 'Used Textbook - ECON101',
        description: 'Like new, $30',
        price: 30,                 // number is fine for Decimal fields
        userId: adminUser.id,
        // status/audience omitted to avoid enum mismatch; defaults apply
      },
      {
        id: randomUUID(),
        title: 'Free Couch',
        description: 'Pickup in Brunswick',
        price: 0,
        userId: communityUser.id,
      },
    ],
  });

  logger.info('✅ Seeded listings');

  // ---------------------------------------------------------------------------
  // Done
  // ---------------------------------------------------------------------------
  logger.info('🌱 Database seeding completed successfully');
}

seed()
  .catch((err) => {
    logger.error({ err }, '❌ Database seeding failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });