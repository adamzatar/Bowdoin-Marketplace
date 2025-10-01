// packages/contracts/src/index.ts

// ─────────────────────────────────────────────────────────────────────────────
// Named exports (kept for backward compatibility with existing imports)
// ─────────────────────────────────────────────────────────────────────────────

// Auth
export { AuthOkSchema } from './schemas/auth';

// Affiliation
export {
  AffiliationFlagsSchema,
  AffiliationPolicyNoteSchema,
} from './schemas/affiliation';

// Listings (keep minimal, non-conflicting named exports)
export { ListingIdSchema } from './schemas/listings';

// Messages
export { MessageIdSchema } from './schemas/messages';

// If you later need specific Upload/Admin schemas as named exports,
// add them here only if they won't collide with similarly named items
// in other modules.

// ─────────────────────────────────────────────────────────────────────────────
// Namespaced exports (preferred going forward to avoid name collisions)
// Consumers can do:  import { Listings } from '@bowdoin/contracts';
// Then use:          Listings.ListingCreateSchema, etc.
// ─────────────────────────────────────────────────────────────────────────────

export * as Auth from './schemas/auth';
export * as Affiliation from './schemas/affiliation';
export * as Listings from './schemas/listings';
export * as Messages from './schemas/messages';
export * as Upload from './schemas/upload';
export * as Admin from './schemas/admin';