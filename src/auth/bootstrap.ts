import type { AppConfig } from '../config';
import type { PrismaClient } from '../db/prisma';
import { normalizeEmail } from './domain';
import { hashPassword } from './passwords';

const SUPERADMIN_NAME = 'Administrador';

/**
 * Makes sure the configured ADMIN_EMAIL account exists as a verified superadmin. An existing
 * account keeps its password; only its roles and verification are ensured.
 */
export async function ensureSuperadmin(
  prisma: PrismaClient,
  admin: AppConfig['admin'],
): Promise<void> {
  const email = normalizeEmail(admin.email);
  if (!email || !admin.password) {
    await warnIfNoAdmins(prisma);
    return;
  }
  const roles = { isAdmin: true, isSuperadmin: true };
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { ...roles, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
    });
    return;
  }
  await prisma.user.create({
    data: {
      email,
      name: SUPERADMIN_NAME,
      passwordHash: await hashPassword(admin.password),
      emailVerifiedAt: new Date(),
      ...roles,
    },
  });
}

async function warnIfNoAdmins(prisma: PrismaClient): Promise<void> {
  if ((await prisma.user.count({ where: { isAdmin: true } })) > 0) return;
  console.warn(
    'ADMIN_EMAIL/ADMIN_PASSWORD are not set and there are no administrators: nobody can manage users.',
  );
}
