import type { PrismaClient } from '../../src/db/prisma';
import { hashPassword } from '../../src/auth/passwords';

export const PASSWORD = 'contraseña-segura';

export async function createUser(
  prisma: PrismaClient,
  email: string,
  { verified = true, password = PASSWORD } = {},
) {
  return prisma.user.create({
    data: {
      email,
      name: 'Usuaria',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
}

/** Extracts the token from the last mailed link that contains `path?token=`. */
export function tokenFromMail(text: string, path: string): string {
  const match = text.match(new RegExp(`${path}\\?token=([\\w-]+)`));
  if (!match) throw new Error(`no ${path} link in: ${text}`);
  return match[1];
}
