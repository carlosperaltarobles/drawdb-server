import type { config } from '../config';
import type { PrismaClient } from '../db/prisma';
import { normalizeEmail } from './domain';
import { hashPassword } from './passwords';

const SUPERADMIN_NAME = 'Administrador';
const roles = { isAdmin: true, isSuperadmin: true };

/**
 * Makes sure the ADMIN_EMAIL account exists as a verified superadmin. A verified account keeps
 * its password. An unverified one was not created by the owner of ADMIN_EMAIL (anyone can
 * register a pending account), so it gets ADMIN_PASSWORD and loses its tokens and sessions.
 */
export async function ensureSuperadmin(
  prisma: PrismaClient,
  admin: typeof config.admin,
): Promise<void> {
  const email = normalizeEmail(admin.email);
  if (!email || !admin.password) {
    await warnIfNoAdmins(prisma);
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.emailVerifiedAt) {
    await prisma.user.update({ where: { id: existing.id }, data: roles });
    return;
  }
  const passwordHash = await hashPassword(admin.password);
  const data = { passwordHash, emailVerifiedAt: new Date(), ...roles };
  if (!existing) {
    await prisma.user.create({ data: { email, name: SUPERADMIN_NAME, ...data } });
    return;
  }
  await prisma.$transaction([
    prisma.emailToken.deleteMany({ where: { userId: existing.id } }),
    prisma.session.deleteMany({ where: { userId: existing.id } }),
    prisma.user.update({ where: { id: existing.id }, data }),
  ]);
}

async function warnIfNoAdmins(prisma: PrismaClient): Promise<void> {
  if ((await prisma.user.count({ where: { isAdmin: true } })) > 0) return;
  console.warn(
    'ADMIN_EMAIL/ADMIN_PASSWORD are not set and there are no administrators: nobody can manage users.',
  );
}
