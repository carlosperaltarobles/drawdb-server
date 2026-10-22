import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser, PASSWORD } from '../helpers/users';
import { savePendingRegistration } from '../../src/auth/registrations';
import { hashPassword, verifyPassword } from '../../src/auth/passwords';

afterAll(async () => {
  await testPrisma().$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

const EMAIL = 'ana@corre-dominio.com';

async function save(password: string) {
  const prisma = testPrisma();
  const passwordHash = await hashPassword(password);
  return prisma.$transaction((tx) =>
    savePendingRegistration(tx, { email: EMAIL, name: 'Otra', passwordHash }),
  );
}

describe('savePendingRegistration', () => {
  it('no toca una cuenta ya verificada ni emite token', async () => {
    const prisma = testPrisma();
    await createUser(prisma, EMAIL);
    expect(await save('contraseña-del-atacante')).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    expect(user.name).toBe('Usuaria');
    expect(await prisma.emailToken.count()).toBe(0);
  });

  it('sobrescribe una cuenta pendiente y emite un token', async () => {
    const prisma = testPrisma();
    await createUser(prisma, EMAIL, { verified: false });
    expect(await save('contraseña-nueva-1')).toEqual(expect.any(String));
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await verifyPassword(user.passwordHash, 'contraseña-nueva-1')).toBe(true);
    expect(await prisma.emailToken.count()).toBe(1);
  });

  it('crea la cuenta si no existe', async () => {
    expect(await save(PASSWORD)).toEqual(expect.any(String));
    expect(await testPrisma().user.count()).toBe(1);
  });
});
