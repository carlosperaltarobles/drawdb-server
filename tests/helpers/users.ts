import type { PrismaClient } from '../../src/db/prisma';
import { hashPassword } from '../../src/auth/passwords';
import { createSession, SESSION_COOKIE } from '../../src/auth/sessions';

export const PASSWORD = 'contraseña-segura';

export async function createUser(
  prisma: PrismaClient,
  email: string,
  { verified = true, password = PASSWORD, isAdmin = false, isSuperadmin = false } = {},
) {
  return prisma.user.create({
    data: {
      email,
      name: 'Usuaria',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: verified ? new Date() : null,
      isAdmin,
      isSuperadmin,
    },
  });
}

/** A `Cookie` header value with a fresh session for the user. */
export async function sessionCookie(prisma: PrismaClient, userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(prisma, userId)}`;
}

/** Extracts the token from the `<path>?token=` link in a mail's text. */
export function tokenFromMail(text: string, path: string): string {
  const match = text.match(new RegExp(`${path}\\?token=([\\w-]+)`));
  if (!match) throw new Error(`no ${path} link in: ${text}`);
  return match[1];
}
