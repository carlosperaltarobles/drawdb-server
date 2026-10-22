import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';
import { ensureSuperadmin } from '../../src/auth/bootstrap';
import { verifyPassword } from '../../src/auth/passwords';

afterAll(async () => {
  await testPrisma().$disconnect();
});

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

const admin = { email: 'jefa@admin-dominio.com', password: 'clave-del-administrador' };

describe('ensureSuperadmin', () => {
  it('crea al superadmin verificado si no existe', async () => {
    const prisma = testPrisma();
    await ensureSuperadmin(prisma, admin);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: admin.email } });
    expect(user).toMatchObject({ isAdmin: true, isSuperadmin: true });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(user.passwordHash, admin.password)).toBe(true);
  });

  it('si ya existe no cambia su contraseña', async () => {
    const prisma = testPrisma();
    await createUser(prisma, admin.email, { password: 'otra-contraseña-propia' });
    await ensureSuperadmin(prisma, admin);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: admin.email } });
    expect(await verifyPassword(user.passwordHash, 'otra-contraseña-propia')).toBe(true);
    expect(user).toMatchObject({ isAdmin: true, isSuperadmin: true });
  });

  it('sin variables y sin administradores avisa por consola', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ensureSuperadmin(testPrisma(), { email: '', password: '' });
    expect(warn).toHaveBeenCalledOnce();
    expect(await testPrisma().user.count()).toBe(0);
  });
});
