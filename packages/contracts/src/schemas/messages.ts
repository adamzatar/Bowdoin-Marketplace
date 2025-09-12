// packages/contracts/src/schemas/messages.ts
import { z } from 'zod';

import { ListingIdSchema } from './listings';
import { PublicUserSchema } from './users';

/* ------------------------------------------------------------------ */
/* Core message + thread primitives                                   */
/* ------------------------------------------------------------------ */

export const MessageIdSchema = z.string().uuid();
export type MessageId = z.infer<typeof MessageIdSchema>;

export const ThreadIdSchema = z.string().uuid();
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export const MessageStatusEnum = z.enum(['sent', 'delivered', 'read']);
export type MessageStatus = z.infer<typeof MessageStatusEnum>;

/** Base message content constraints */
export const MessageContentSchema = z.object({
  text: z.string().min(1).max(5_000),
});
export type MessageContent = z.infer<typeof MessageContentSchema>;

/* ------------------------------------------------------------------ */
/* Message shapes                                                      */
/* ------------------------------------------------------------------ */

export const MessageCoreSchema = z.object({
  id: MessageIdSchema,
  threadId: ThreadIdSchema,
  senderId: z.string().uuid(),
  content: MessageContentSchema,
  status: MessageStatusEnum,
  createdAt: z.string().datetime(),
});
export type MessageCore = z.infer<typeof MessageCoreSchema>;

/** Expanded with sender details */
export const MessageWithSenderSchema = MessageCoreSchema.extend({
  sender: PublicUserSchema,
});
export type MessageWithSender = z.infer<typeof MessageWithSenderSchema>;

/* ------------------------------------------------------------------ */
/* Thread shapes                                                       */
/* ------------------------------------------------------------------ */

export const ThreadCoreSchema = z.object({
  id: ThreadIdSchema,
  listingId: ListingIdSchema.nullable(), // optional — may be general DM
  participants: z.array(PublicUserSchema).min(2).max(20),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ThreadCore = z.infer<typeof ThreadCoreSchema>;

/** Expanded thread with messages */
export const ThreadWithMessagesSchema = ThreadCoreSchema.extend({
  messages: z.array(MessageWithSenderSchema),
});
export type ThreadWithMessages = z.infer<typeof ThreadWithMessagesSchema>;

/* ------------------------------------------------------------------ */
/* Create message                                                      */
/* ------------------------------------------------------------------ */

export const CreateMessageBodySchema = z.object({
  threadId: ThreadIdSchema,
  text: z.string().min(1).max(5_000),
});
export type CreateMessageBody = z.infer<typeof CreateMessageBodySchema>;

export const CreateMessageResponseSchema = MessageWithSenderSchema;
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

/* ------------------------------------------------------------------ */
/* Create thread                                                       */
/* ------------------------------------------------------------------ */

export const CreateThreadBodySchema = z.object({
  listingId: ListingIdSchema.optional(),
  participantIds: z.array(z.string().uuid()).min(1),
  firstMessage: z.string().min(1).max(5_000).optional(),
});
export type CreateThreadBody = z.infer<typeof CreateThreadBodySchema>;

export const CreateThreadResponseSchema = ThreadWithMessagesSchema;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;

/* ------------------------------------------------------------------ */
/* Get thread(s)                                                       */
/* ------------------------------------------------------------------ */

export const GetThreadParamsSchema = z.object({
  id: ThreadIdSchema,
});
export type GetThreadParams = z.infer<typeof GetThreadParamsSchema>;

export const GetThreadResponseSchema = ThreadWithMessagesSchema;
export type GetThreadResponse = z.infer<typeof GetThreadResponseSchema>;

export const ListThreadsQuerySchema = z.object({
  listingId: ListingIdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListThreadsQuery = z.infer<typeof ListThreadsQuerySchema>;

export const ListThreadsResponseSchema = z.object({
  items: z.array(ThreadCoreSchema),
  nextCursor: z.string().optional(),
});
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;

/* ------------------------------------------------------------------ */
/* Mark as read                                                        */
/* ------------------------------------------------------------------ */

export const MarkReadBodySchema = z.object({
  threadId: ThreadIdSchema,
  messageIds: z.array(MessageIdSchema).min(1),
});
export type MarkReadBody = z.infer<typeof MarkReadBodySchema>;

export const MarkReadResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;