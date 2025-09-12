// packages/db/seed/community.seed.ts
/**
 * Community (Brunswick) population seed
 *
 * Purpose:
 *  - Populate a realistic set of community (non-Bowdoin) users.
 *  - Create a handful of public listings visible to Bowdoin + Community.
 *  - (Optionally) create basic message threads across the Bowdoin/community boundary
 *    to exercise authorization checks.
 *
 * Design:
 *  - Idempotent upserts keyed by email and deterministic IDs where helpful.
 *  - Never runs automatically in production.
 *  - Exported `runCommunitySeed` so the main seed can call it, plus a CLI entry
 *    for local ad-hoc execution: `pnpm -w run db:seed:community`.
 */

import { logger } from '@bowdoin/observability/logger';
import { PrismaClient, Affiliation, Role, ListingStatus } from '@prisma/client';

type Options = {
  /**
   * When true, also create cross-affiliation threads/messages to verify policy.
   */
  createCrossAffiliationThreads?: boolean;
  /**
   * When provided, an existing Bowdoin member email will be used as the
   * "buyer" in cross-affiliation threads; if not found, threads are skipped.
   */
  bowdoinBuyerEmail?: string;
};

export async function runCommunitySeed(prisma: PrismaClient, opts: Options = {}) {
  const now = new Date();

  logger.info({ msg: 'Community seed: starting…', opts });

  // Ensure audience tags exist (in case this runs standalone)
  const [tagCommunity] = await Promise.all([
    prisma.audienceTag.upsert({
      where: { key: 'community_allowed' },
      update: { name: 'Bowdoin + Community' },
      create: { key: 'community_allowed', name: 'Bowdoin + Community' },
    }),
  ]);

  // A small, realistic set of community accounts
  const communityAccounts = [
    {
      id: '10000000-0000-0000-0000-000000000101',
      name: 'Alex Johnson',
      email: 'alex.johnson@brunswickmail.org',
      verifiedAt: now,
    },
    {
      id: '10000000-0000-0000-0000-000000000102',
      name: 'Casey Lee',
      email: 'casey.lee@maine.local',
      verifiedAt: now,
    },
    {
      id: '10000000-0000-0000-0000-000000000103',
      name: 'Jordan Kim',
      email: 'jordan.kim@brunswick.community',
      verifiedAt: null, // not yet community-verified
    },
    {
      id: '10000000-0000-0000-0000-000000000104',
      name: 'Taylor Smith',
      email: 'taylor.smith@neighborhood.net',
      verifiedAt: now,
    },
  ] as const;

  const users = await Promise.all(
    communityAccounts.map((u) =>
      prisma.user.upsert({
        where: { email: u.email },
        update: {
          name: u.name,
          affiliation: Affiliation.community,
          role: Role.student,
          // keep existing emailVerified if already set
          communityEmailVerified: u.verifiedAt ?? undefined,
        },
        create: {
          id: u.id,
          email: u.email,
          name: u.name,
          role: Role.student,
          affiliation: Affiliation.community,
          emailVerified: now, // account verified as an app user
          communityEmailVerified: u.verifiedAt,
        },
      }),
    ),
  );

  logger.info({
    msg: 'Community seed: users upserted',
    count: users.length,
    verified: users.filter((u) => u.communityEmailVerified).length,
  });

  // Listings authored by community members, visible to Bowdoin + Community
  const listingSpecs = [
    {
      id: '20000000-0000-0000-0000-000000000201',
      ownerEmail: 'alex.johnson@brunswickmail.org',
      title: 'Bike — commuter, medium frame',
      description:
        'Gently used commuter bike, includes lights and a bell. Pickup in Brunswick; can meet near campus.',
      price: 75,
      isFree: false,
      condition: 'good',
      category: 'Bikes',
      location: 'Brunswick – Maine Street',
    },
    {
      id: '20000000-0000-0000-0000-000000000202',
      ownerEmail: 'casey.lee@maine.local',
      title: 'Bookshelf (Free)',
      description:
        'Sturdy IKEA bookshelf (white). Some wear on edges. First-come, first-served. I can help load.',
      price: 0,
      isFree: true,
      condition: 'fair',
      category: 'Furniture',
      location: 'Brunswick – near Bowdoin campus',
    },
    {
      id: '20000000-0000-0000-0000-000000000203',
      ownerEmail: 'taylor.smith@neighborhood.net',
      title: 'Kitchen set: pots & pans',
      description:
        'Assorted pots and pans, non-stick. Perfect for a student kitchen setup. Bundle price.',
      price: 20,
      isFree: false,
      condition: 'good',
      category: 'Kitchen',
      location: 'Brunswick – Pleasant St.',
    },
  ] as const;

  // Map owners
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const listings = await Promise.all(
    listingSpecs.map((l) => {
      const owner = byEmail.get(l.ownerEmail);
      if (!owner) {
        throw new Error(`Owner not found for seed listing: ${l.ownerEmail}`);
      }
      return prisma.listing.upsert({
        where: { id: l.id },
        update: {
          title: l.title,
          description: l.description,
          price: l.price,
          isFree: l.isFree,
          condition: l.condition,
          category: l.category,
          location: l.location,
          status: ListingStatus.active,
          audienceTagId: tagCommunity.id,
        },
        create: {
          id: l.id,
          userId: owner.id,
          title: l.title,
          description: l.description,
          price: l.price,
          isFree: l.isFree,
          condition: l.condition,
          category: l.category,
          location: l.location,
          availableStart: now,
          availableEnd: null,
          status: ListingStatus.active,
          audienceTagId: tagCommunity.id,
          createdAt: now,
          updatedAt: now,
        },
      });
    }),
  );

  logger.info({
    msg: 'Community seed: listings upserted',
    count: listings.length,
    ids: listings.map((l) => l.id),
  });

  // Optional: create a thread between a Bowdoin buyer and a community seller for the first listing
  if (opts.createCrossAffiliationThreads && opts.bowdoinBuyerEmail) {
    const bowdoinBuyer = await prisma.user.findUnique({
      where: { email: opts.bowdoinBuyerEmail },
      select: { id: true, affiliation: true, email: true },
    });

    if (!bowdoinBuyer) {
      logger.warn({
        msg: 'Community seed: bowdoinBuyerEmail not found; skipping cross-affiliation thread.',
        bowdoinBuyerEmail: opts.bowdoinBuyerEmail,
      });
    } else if (bowdoinBuyer.affiliation !== Affiliation.bowdoin_member) {
      logger.warn({
        msg: 'Community seed: provided bowdoinBuyerEmail is not a Bowdoin member; skipping thread.',
        bowdoinBuyerEmail: bowdoinBuyer.email,
      });
    } else {
      const targetListing = listings[0];
      const seller = await prisma.user.findUniqueOrThrow({
        where: { id: targetListing.userId },
        select: { id: true, email: true },
      });

      const thread = await prisma.thread.upsert({
        where: {
          listingId_buyerId: { listingId: targetListing.id, buyerId: bowdoinBuyer.id },
        },
        update: {},
        create: {
          id: '30000000-0000-0000-0000-000000000301',
          listingId: targetListing.id,
          sellerId: seller.id,
          buyerId: bowdoinBuyer.id,
          createdAt: now,
        },
      });

      await prisma.message.upsert({
        where: { id: '30000000-0000-0000-0000-0000000003a1' },
        update: {
          body: 'Hi! Interested in the commuter bike. Is it still available?',
          sentAt: now,
          senderId: bowdoinBuyer.id,
          threadId: thread.id,
        },
        create: {
          id: '30000000-0000-0000-0000-0000000003a1',
          body: 'Hi! Interested in the commuter bike. Is it still available?',
          sentAt: now,
          senderId: bowdoinBuyer.id,
          threadId: thread.id,
        },
      });

      await prisma.message.upsert({
        where: { id: '30000000-0000-0000-0000-0000000003a2' },
        update: {
          body: 'Yes! I can meet near campus later today.',
          sentAt: new Date(now.getTime() + 90_000),
          senderId: seller.id,
          threadId: thread.id,
        },
        create: {
          id: '30000000-0000-0000-0000-0000000003a2',
          body: 'Yes! I can meet near campus later today.',
          sentAt: new Date(now.getTime() + 90_000),
          senderId: seller.id,
          threadId: thread.id,
        },
      });

      logger.info({
        msg: 'Community seed: cross-affiliation thread created',
        threadId: thread.id,
        listingId: targetListing.id,
        buyer: bowdoinBuyer.email,
        seller: seller.email,
      });
    }
  }

  logger.info({ msg: 'Community seed: complete.' });
}

/**
 * Allow running this seed directly:
 *   pnpm -w ts-node packages/db/seed/community.seed.ts
 * or via package script `db:seed:community`.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient();
  const buyer = process.env.BOWDOIN_BUYER_EMAIL || process.env.BOWDOIN_STUDENT_EMAIL; // tolerate a common typo
  const withThreads = process.env.CREATE_CROSS_AFFILIATION_THREADS === '1';

  runCommunitySeed(prisma, {
    createCrossAffiliationThreads: withThreads,
    bowdoinBuyerEmail: buyer,
  })
    .catch((err) => {
       
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}