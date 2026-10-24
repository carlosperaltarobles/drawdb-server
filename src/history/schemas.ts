import { z } from 'zod';
import { projectParams } from '../projects/schemas';
import { HISTORY_PAGE, NAME_MAX } from './constants';

export { projectParams };

export const snapshotParams = projectParams.extend({
  snapshotId: z.uuid(),
});

export const listQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(HISTORY_PAGE),
});

export const snapshotNameSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
});
