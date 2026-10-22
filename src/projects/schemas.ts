import { z } from 'zod';
import { emailSchema } from '../auth/schemas';
import { ProjectRole } from '../generated/prisma/enums';

const role = z.enum(ProjectRole);

export const projectParams = z.object({ id: z.uuid() });
export const memberParams = projectParams.extend({ userId: z.uuid() });
export const invitationParams = projectParams.extend({ invId: z.uuid() });

export const projectNameSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const addMemberSchema = emailSchema.extend({ role });
export const memberRoleSchema = z.object({ role });
