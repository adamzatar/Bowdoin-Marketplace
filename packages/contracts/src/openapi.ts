// packages/contracts/src/openapi.ts

// Auth
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  AffiliationFlagsSchema,
  AffiliationPolicyNoteSchema, // this one exists per your error message
} from './schemas/affiliation';
import { AuthOkSchema } from './schemas/auth';

// Users
// (If you have user zods, import them explicitly here, e.g. UserSchema)
// import { UserSchema } from './schemas/users';

// Affiliation

// Health
// import { HealthOkSchema } from './schemas/health';

// Listings
import { ListingIdSchema } from './schemas/listings';

// Messages
import { MessageIdSchema } from './schemas/messages';

// Upload
// import { UploadInitSchema } from './schemas/upload';

// Admin
// If admin exports collide with listings, only import distinct names here.
// import { SomeAdminOnlySchema } from './schemas/admin';

// --- Helpers to convert zod to JSON Schema (optional if you already do this elsewhere)

import type { OpenAPIObject } from 'openapi3-ts/oas31';
import type { z } from 'zod';

function toSchema(zod: z.ZodTypeAny, name: string) {
  return zodToJsonSchema(zod, { name, target: 'openApi3' });
}

// ------------------------------------------------------------------
// Minimal OpenAPI object that compiles and exposes known schemas.
// Extend with your route paths as needed.
// ------------------------------------------------------------------
export const openapi: OpenAPIObject = {
  openapi: '3.1.0',
  info: {
    title: 'Bowdoin Marketplace API',
    version: '0.1.0',
    description: 'OpenAPI specification for Bowdoin Marketplace',
  },
  servers: [],
  paths: {},
  components: {
    schemas: {
      // Auth
      AuthOk: toSchema(AuthOkSchema, 'AuthOk'),

      // Affiliation
      AffiliationFlags: toSchema(AffiliationFlagsSchema, 'AffiliationFlags'),
      AffiliationPolicyNote: toSchema(AffiliationPolicyNoteSchema, 'AffiliationPolicyNote'),

      // Listings
      ListingId: toSchema(ListingIdSchema, 'ListingId'),

      // Messages
      MessageId: toSchema(MessageIdSchema, 'MessageId'),

      // Add more exports explicitly as you create/need them:
      // User: toSchema(UserSchema, 'User'),
      // HealthOk: toSchema(HealthOkSchema, 'HealthOk'),
      // UploadInit: toSchema(UploadInitSchema, 'UploadInit'),
      // SomeAdminOnly: toSchema(SomeAdminOnlySchema, 'SomeAdminOnly'),
    },
  },
};