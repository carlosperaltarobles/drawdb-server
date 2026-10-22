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

export type ValidEmailToken = { id: string; userId: string };

/** The unused, unexpired token of this type, or null. Does not consume it. */
export function findValidEmailToken(
  db: Prisma.TransactionClient,
  token: string,
  type: EmailTokenType,
): Promise<ValidEmailToken | null> {
  return db.emailToken.findFirst({
    where: { tokenHash: hashToken(token), type, usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userId: true },
  });
}

/**
 * Marks the token used; false when it was used or expired meanwhile. The conditional update
 * means two concurrent requests cannot both use the same token.
 */
export async function markEmailTokenUsed(
  tx: Prisma.TransactionClient,
  tokenId: string,
): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.emailToken.updateMany({
    where: { id: tokenId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return count === 1;
}
