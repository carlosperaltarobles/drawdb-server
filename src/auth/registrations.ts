import type { Prisma } from '../generated/prisma/client';
import { issueEmailToken } from './email-tokens';

export type PendingRegistration = { email: string; name: string; passwordHash: string };

/**
 * Creates the account, or overwrites name and password of a still-unverified one, and returns
 * a new verify token. Returns null when the account is already verified. The overwrite is a
 * conditional update, so an account verified concurrently is never touched.
 */
export async function savePendingRegistration(
  tx: Prisma.TransactionClient,
  { email, name, passwordHash }: PendingRegistration,
): Promise<string | null> {
  const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    const user = await tx.user.create({ data: { email, name, passwordHash } });
    return issueEmailToken(tx, user.id, 'verify');
  }
  const { count } = await tx.user.updateMany({
    where: { id: existing.id, emailVerifiedAt: null },
    data: { name, passwordHash },
  });
  return count === 1 ? issueEmailToken(tx, existing.id, 'verify') : null;
}
