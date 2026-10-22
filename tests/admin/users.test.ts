import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AdminUsersService } from '../../src/admin/users-service';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, sessionCookie } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

async function setup() {
  const ctx = await makeApp();
  const admin = await createUser(ctx.prisma, `jefa@${ALLOWED_DOMAIN}`, { isAdmin: true });
  const adminCookie = await sessionCookie(ctx.prisma, admin.id);
  const setAdmin = (id: string, isAdmin: unknown, cookie = adminCookie) =>
    request(ctx.app).patch(`/api/admin/users/${id}`).set('Cookie', cookie).send({ isAdmin });
  return { ...ctx, admin, adminCookie, setAdmin };
}

describe('/api/admin/users', () => {
  it('lista los usuarios para un administrador y da 403 a los demás', async () => {
    const { app, prisma, admin, adminCookie } = await setup();
    const pending = await createUser(prisma, `ana@${ALLOWED_DOMAIN}`, { verified: false });

    const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: admin.id,
        email: admin.email,
        name: 'Usuaria',
        isAdmin: true,
        isSuperadmin: false,
        verified: true,
        createdAt: admin.createdAt.toISOString(),
      },
      {
        id: pending.id,
        email: pending.email,
        name: 'Usuaria',
        isAdmin: false,
        isSuperadmin: false,
        verified: false,
        createdAt: pending.createdAt.toISOString(),
      },
    ]);

    const user = await createUser(prisma, `eva@${ALLOWED_DOMAIN}`);
    const forbidden = await request(app)
      .get('/api/admin/users')
      .set('Cookie', await sessionCookie(prisma, user.id));
    expect(forbidden.status).toBe(403);
  });

  it('da y quita el rol de administrador', async () => {
    const { prisma, setAdmin } = await setup();
    const user = await createUser(prisma, `ana@${ALLOWED_DOMAIN}`);

    const promoted = await setAdmin(user.id, true);
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id: user.id, isAdmin: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isAdmin).toBe(true);

    const demoted = await setAdmin(user.id, false);
    expect(demoted.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isAdmin).toBe(false);
  });

  it('no deja cambiar el rol del superadmin', async () => {
    const { prisma, setAdmin } = await setup();
    const superadmin = await createUser(prisma, `root@${ALLOWED_DOMAIN}`, {
      isAdmin: true,
      isSuperadmin: true,
    });
    const res = await setAdmin(superadmin.id, false);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_change_superadmin' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: superadmin.id } })).isAdmin).toBe(
      true,
    );
  });

  it('no deja quitar el último administrador', async () => {
    const { admin, setAdmin } = await setup();
    const res = await setAdmin(admin.id, false);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'last_admin' });
  });

  it('una degradación espera a otra en curso y no deja el sistema sin administradores', async () => {
    const { prisma, admin } = await setup();
    const other = await createUser(prisma, `otra@${ALLOWED_DOMAIN}`, { isAdmin: true });
    let lockTaken!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>((resolve) => (lockTaken = resolve));
    const canFinish = new Promise<void>((resolve) => (finish = resolve));

    // A concurrent demotion of `admin` that holds the administrators' row locks.
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`select id from users where is_admin for update`;
      lockTaken();
      await canFinish;
      await tx.user.update({ where: { id: admin.id }, data: { isAdmin: false } });
    });
    await locked;
    const second = new AdminUsersService({ prisma }).setAdmin(other.id, false);
    second.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    finish();
    await first;

    await expect(second).rejects.toMatchObject({ code: 'last_admin' });
    expect(await prisma.user.count({ where: { isAdmin: true } })).toBe(1);
  });

  it('no permite promocionar a administrador a un usuario no verificado', async () => {
    const { prisma, setAdmin } = await setup();
    const unverified = await createUser(prisma, `pendiente@${ALLOWED_DOMAIN}`, { verified: false });

    const res = await setAdmin(unverified.id, true);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'user_not_verified' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: unverified.id } })).isAdmin).toBe(
      false,
    );
  });

  it('valida la entrada y da 404 con un usuario inexistente', async () => {
    const { admin, setAdmin } = await setup();
    const invalid = await setAdmin(admin.id, 'sí');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_input' });
    const badId = await setAdmin('no-es-uuid', true);
    expect(badId.status).toBe(400);
    const missing = await setAdmin(UNKNOWN_ID, true);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});
