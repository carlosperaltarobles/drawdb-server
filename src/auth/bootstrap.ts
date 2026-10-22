import type { PrismaClient } from '../db/prisma';

// Implemented in Task 4.
export async function ensureSuperadmin(
  _prisma: PrismaClient,
  _admin: { email: string; password: string },
): Promise<void> {}
