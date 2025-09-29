/*
  Warnings:

  - The values [brunswick,unknown] on the enum `Affiliation` will be removed. If these variants are still used in the database, this will fail.
  - The values [community,both] on the enum `Audience` will be removed. If these variants are still used in the database, this will fail.
  - The primary key for the `AuditLog` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `actorIp` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `actorUA` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `event` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `meta` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `scope` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `targetId` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `targetType` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `timestamp` on the `AuditLog` table. All the data in the column will be lost.
  - The primary key for the `Listing` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `ListingPhoto` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `position` on the `ListingPhoto` table. All the data in the column will be lost.
  - The primary key for the `Message` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `readAt` on the `Message` table. All the data in the column will be lost.
  - The primary key for the `Report` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Thread` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `closed` on the `Thread` table. All the data in the column will be lost.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `status` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `verifiedAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `VerificationToken` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `updatedAt` to the `Report` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."Affiliation_new" AS ENUM ('bowdoin', 'community');
ALTER TABLE "public"."User" ALTER COLUMN "affiliation" DROP DEFAULT;
ALTER TABLE "public"."User" ALTER COLUMN "affiliation" TYPE "public"."Affiliation_new" USING ("affiliation"::text::"public"."Affiliation_new");
ALTER TYPE "public"."Affiliation" RENAME TO "Affiliation_old";
ALTER TYPE "public"."Affiliation_new" RENAME TO "Affiliation";
DROP TYPE "public"."Affiliation_old";
ALTER TABLE "public"."User" ALTER COLUMN "affiliation" SET DEFAULT 'bowdoin';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "public"."Audience_new" AS ENUM ('campus', 'public');
ALTER TABLE "public"."Listing" ALTER COLUMN "audience" DROP DEFAULT;
ALTER TABLE "public"."Listing" ALTER COLUMN "audience" TYPE "public"."Audience_new" USING ("audience"::text::"public"."Audience_new");
ALTER TYPE "public"."Audience" RENAME TO "Audience_old";
ALTER TYPE "public"."Audience_new" RENAME TO "Audience";
DROP TYPE "public"."Audience_old";
ALTER TABLE "public"."Listing" ALTER COLUMN "audience" SET DEFAULT 'campus';
COMMIT;

-- AlterEnum
ALTER TYPE "public"."Condition" ADD VALUE 'excellent';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."Role" ADD VALUE 'faculty';
ALTER TYPE "public"."Role" ADD VALUE 'community';

-- DropForeignKey
ALTER TABLE "public"."AuditLog" DROP CONSTRAINT "AuditLog_actorUserId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Listing" DROP CONSTRAINT "Listing_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ListingPhoto" DROP CONSTRAINT "ListingPhoto_listingId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Message" DROP CONSTRAINT "Message_senderId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Message" DROP CONSTRAINT "Message_threadId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Report" DROP CONSTRAINT "Report_reportedListingId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Report" DROP CONSTRAINT "Report_reportedUserId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Report" DROP CONSTRAINT "Report_reporterId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Thread" DROP CONSTRAINT "Thread_buyerId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Thread" DROP CONSTRAINT "Thread_listingId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Thread" DROP CONSTRAINT "Thread_sellerId_fkey";

-- DropForeignKey
ALTER TABLE "public"."VerificationToken" DROP CONSTRAINT "VerificationToken_userId_fkey";

-- DropIndex
DROP INDEX "public"."idx_auditlog_event";

-- DropIndex
DROP INDEX "public"."idx_auditlog_metadata_gin";

-- DropIndex
DROP INDEX "public"."idx_auditlog_scope";

-- DropIndex
DROP INDEX "public"."idx_auditlog_target";

-- DropIndex
DROP INDEX "public"."idx_auditlog_time";

-- DropIndex
DROP INDEX "public"."idx_auditlog_ts_desc";

-- DropIndex
DROP INDEX "public"."idx_listing_created_at";

-- DropIndex
DROP INDEX "public"."idx_listingphoto_order";

-- DropIndex
DROP INDEX "public"."idx_message_sender";

-- DropIndex
DROP INDEX "public"."idx_thread_listing";

-- DropIndex
DROP INDEX "public"."idx_user_status";

-- AlterTable
ALTER TABLE "public"."AuditLog" DROP CONSTRAINT "AuditLog_pkey",
DROP COLUMN "actorIp",
DROP COLUMN "actorUA",
DROP COLUMN "event",
DROP COLUMN "meta",
DROP COLUMN "scope",
DROP COLUMN "targetId",
DROP COLUMN "targetType",
DROP COLUMN "timestamp",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "actorUserId" SET DATA TYPE TEXT,
ALTER COLUMN "entityId" SET DATA TYPE TEXT,
ALTER COLUMN "ip" SET DATA TYPE TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "metadata" DROP NOT NULL,
ALTER COLUMN "metadata" DROP DEFAULT,
ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "AuditLog_id_seq";

-- AlterTable
ALTER TABLE "public"."Listing" DROP CONSTRAINT "Listing_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "userId" SET DATA TYPE TEXT,
ALTER COLUMN "price" DROP DEFAULT,
ALTER COLUMN "availableStart" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "availableEnd" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "Listing_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."ListingPhoto" DROP CONSTRAINT "ListingPhoto_pkey",
DROP COLUMN "position",
ADD COLUMN     "caption" TEXT,
ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "listingId" SET DATA TYPE TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "ListingPhoto_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Message" DROP CONSTRAINT "Message_pkey",
DROP COLUMN "readAt",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "threadId" SET DATA TYPE TEXT,
ALTER COLUMN "senderId" SET DATA TYPE TEXT,
ALTER COLUMN "sentAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "Message_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Report" DROP CONSTRAINT "Report_pkey",
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "reportedListingId" SET DATA TYPE TEXT,
ALTER COLUMN "reportedUserId" SET DATA TYPE TEXT,
ALTER COLUMN "reporterId" SET DATA TYPE TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "Report_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."Thread" DROP CONSTRAINT "Thread_pkey",
DROP COLUMN "closed",
ADD COLUMN     "closedAt" TIMESTAMP(3),
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "listingId" SET DATA TYPE TEXT,
ALTER COLUMN "sellerId" SET DATA TYPE TEXT,
ALTER COLUMN "buyerId" SET DATA TYPE TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "Thread_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "status",
DROP COLUMN "verifiedAt",
ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "communityVerifiedAt" TIMESTAMP(3),
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "affiliation" SET DEFAULT 'bowdoin',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "public"."VerificationToken";

-- DropEnum
DROP TYPE "public"."AccountStatus";

-- DropEnum
DROP TYPE "public"."audit_event";

-- DropEnum
DROP TYPE "public"."audit_scope";

-- CreateTable
CREATE TABLE "public"."VerificationRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationRequest_userId_purpose_idx" ON "public"."VerificationRequest"("userId", "purpose");

-- CreateIndex
CREATE INDEX "VerificationRequest_expiresAt_idx" ON "public"."VerificationRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "VerificationRequest_tokenHash_idx" ON "public"."VerificationRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "public"."AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Listing_availableEnd_idx" ON "public"."Listing"("availableEnd");

-- AddForeignKey
ALTER TABLE "public"."Listing" ADD CONSTRAINT "Listing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ListingPhoto" ADD CONSTRAINT "ListingPhoto_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_reportedListingId_fkey" FOREIGN KEY ("reportedListingId") REFERENCES "public"."Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VerificationRequest" ADD CONSTRAINT "VerificationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "public"."idx_auditlog_actor" RENAME TO "AuditLog_actorUserId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_auditlog_entity" RENAME TO "AuditLog_entityType_entityId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_listing_audience" RENAME TO "Listing_audience_idx";

-- RenameIndex
ALTER INDEX "public"."idx_listing_status" RENAME TO "Listing_status_idx";

-- RenameIndex
ALTER INDEX "public"."idx_listing_user" RENAME TO "Listing_userId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_listingphoto_listing" RENAME TO "ListingPhoto_listingId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_message_thread" RENAME TO "Message_threadId_sentAt_idx";

-- RenameIndex
ALTER INDEX "public"."idx_report_listing" RENAME TO "Report_reportedListingId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_report_status" RENAME TO "Report_status_idx";

-- RenameIndex
ALTER INDEX "public"."idx_report_user" RENAME TO "Report_reportedUserId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_thread_buyer" RENAME TO "Thread_buyerId_idx";

-- RenameIndex
ALTER INDEX "public"."idx_thread_seller" RENAME TO "Thread_sellerId_idx";

-- RenameIndex
ALTER INDEX "public"."thread_unique_per_buyer" RENAME TO "Thread_listingId_buyerId_key";

-- RenameIndex
ALTER INDEX "public"."idx_user_affiliation" RENAME TO "User_affiliation_idx";

-- RenameIndex
ALTER INDEX "public"."idx_user_role" RENAME TO "User_role_idx";
