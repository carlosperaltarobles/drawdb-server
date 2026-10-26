import { z } from 'zod';

export const projectIdParams = z.strictObject({
  id: z.uuid(),
});

export const conversationIdParams = z.strictObject({
  id: z.uuid(),
  cid: z.uuid(),
});

export const generationIdParams = z.strictObject({
  id: z.uuid(),
  gid: z.uuid(),
});

export const proposalIdParams = z.strictObject({
  id: z.uuid(),
  pid: z.uuid(),
});

export const modelsQuerySchema = z.strictObject({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const paginationQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const createConversationSchema = z.strictObject({
  selectedModel: z.string().trim().min(1).max(200).optional(),
});

export const updateConversationModelSchema = z.strictObject({
  selectedModel: z.string().trim().min(1).max(200),
});

export const sendMessageSchema = z.strictObject({
  content: z.string().trim().min(1).max(8000),
  requestId: z.uuid(),
  continuation: z.string().trim().max(4096).optional(),
});

export const applyProposalSchema = z.strictObject({
  revision: z.number().int().positive(),
});
