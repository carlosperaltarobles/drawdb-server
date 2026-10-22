import type { PrismaClient } from '../db/prisma';
import { hashToken, newToken } from './tokens';
import { toPublicUser, type PublicUser } from './public-user';

export const SESSION_COOKIE = 'drawdb_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Creates a session and returns the raw token for the cookie; only its hash is stored. */
export async function createSession(prisma: PrismaClient, userId: string): Promise<string> {
  const { token, hash } = newToken();
  await prisma.session.create({
    data: { id: hash, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}

/** The session's user, or null when the token is unknown or expired (expired ones are deleted). */
export async function getSessionUser(
  prisma: PrismaClient,
  token: string,
): Promise<PublicUser | null> {
  const id = hashToken(token);
  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await prisma.session.deleteMany({ where: { id } });
    return null;
  }
  return toPublicUser(session.user);
}

export async function destroySession(
  prisma: PrismaClient,
  token: string,
): Promise<string | null> {
  const id = hashToken(token);
  const session = await prisma.session.findUnique({ where: { id }, select: { userId: true } });
  await prisma.session.deleteMany({ where: { id } });
  return session?.userId ?? null;
}

export async function destroyOtherSessions(
  prisma: PrismaClient,
  userId: string,
  keepToken: string,
): Promise<void> {
  await prisma.session.deleteMany({ where: { userId, id: { not: hashToken(keepToken) } } });
}
