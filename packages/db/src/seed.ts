/**
 * Bowdoin Marketplace — Database Seed Script
 *
 * Seeds development data into the database.
 * Safe to run multiple times (idempotent where possible).
 */

import { randomUUID } from 'crypto';

import { logger } from '@bowdoin/observability/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seed() {
  logger.info('🌱 Starting database seeding...');

  // ---------------------------------------------------------------------------
  // Example Users
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
      role: 'ADMIN',
      affiliation: 'CAMPUS',
    },
  });

  const communityUser = await prisma.user.upsert({
    where: { email: communityEmail },
    update: {},
    create: {
      id: randomUUID(),
      email: communityEmail,
      name: 'Community Tester',
      role: 'USER',
      affiliation: 'COMMUNITY',
      communityEmail,
      communityVerifiedAt: new Date(),
    },
  });

  logger.info(
    { adminId: adminUser.id, communityId: communityUser.id },
    '✅ Seeded users'
  );

  // ---------------------------------------------------------------------------
  // Example Listings
  // ---------------------------------------------------------------------------

  await prisma.listing.createMany({
    skipDuplicates: true,
    data: [
      {
        id: randomUUID(),
        title: 'Used Textbook - ECON101',
        description: 'Like new, $30',
        price: 30,
        status: 'ACTIVE',
        sellerId: adminUser.id,
        audience: 'CAMPUS',
      },
      {
        id: randomUUID(),
        title: 'Free Couch',
        description: 'Pickup in Brunswick',
        price: 0,
        status: 'ACTIVE',
        sellerId: communityUser.id,
        audience: 'COMMUNITY',
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
    logger.error(err, '❌ Database seeding failed');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });