// packages/email/src/index.ts
/**
 * @module @bowdoin/email
 * Public entry for the email package.
 *
 * Re-exports the verification mailer so consumers can do:
 *   import { sendVerificationEmail } from "@bowdoin/email";
 *
 * Keeping the root export stable avoids subpath resolution issues in bundlers
 * and during TypeScript DTS generation across the monorepo.
 */

export {
  sendVerificationEmail,
  renderVerificationEmailPreview,
} from "./sendVerificationEmail";

// If you later add more mailers (password reset, notifications, etc.),
// re-export them here to keep the root as the single stable entry point.
// export { sendPasswordResetEmail } from "./sendPasswordResetEmail";
// export type { PasswordResetPayload } from "./sendPasswordResetEmail";