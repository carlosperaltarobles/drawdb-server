import type { EmailTokenType, Prisma } from '../generated/prisma/client';
import { hashToken, newToken } from './tokens';

const HOUR_MS = 60 * 60 * 1000;

const TTL_MS: Record<EmailTokenType, number> = {
  verify: 24 * HOUR_MS,
  reset: HOUR_MS,
};

/** Replaces the user's unused tokens of this type with a new one and returns the raw token. */
export async function issueEmailToken(
  tx: Prisma.TransactionClient,
  userId: string,
  type: EmailTokenType,
): Promise<string> {
  await tx.emailToken.deleteMany({ where: { userId, type, usedAt: null } });
  const { token, hash } = newToken();
  await tx.emailToken.create({
    data: { userId, type, tokenHash: hash, expiresAt: new Date(Date.now() + TTL_MS[type]) },
  });
  return token;
}

/** Marks a valid, unused, unexpired token as used and returns its user id, or null. */
export async function consumeEmailToken(
  tx: Prisma.TransactionClient,
  token: string,
  type: EmailTokenType,
): Promise<string | null> {
  const now = new Date();
  const found = await tx.emailToken.findFirst({
    where: { tokenHash: hashToken(token), type, usedAt: null, expiresAt: { gt: now } },
  });
  if (!found) return null;
  // Conditional update so two concurrent requests cannot both use the same token.
  const { count } = await tx.emailToken.updateMany({
    where: { id: found.id, usedAt: null },
    data: { usedAt: now },
  });
  return count === 1 ? found.userId : null;
}
