// packages/contracts/src/index.ts

// Auth
export { AuthOkSchema } from './schemas/auth';

// Users (export only unique names)
// export { UserSchema, UserIdSchema } from './schemas/users';

// Affiliation
export {
  AffiliationFlagsSchema,
  AffiliationPolicyNoteSchema,
} from './schemas/affiliation';

// Health
// export { HealthOkSchema } from './schemas/health';

// Listings
export {
  ListingIdSchema,
  // Export other listing-only schemas here,
  // but DO NOT re-export names that also exist in ./schemas/admin
  // e.g., if admin defines RemoveListing*, re-export those ONLY from admin.
} from './schemas/listings';

// Messages
export { MessageIdSchema } from './schemas/messages';

// Upload
// export { UploadInitSchema } from './schemas/upload';

// Admin
// Export admin-only names that don't collide with listings
// export { AdminOnlyThingSchema } from './schemas/admin';