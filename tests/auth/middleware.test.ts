import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';
import { requireAdmin, requireAuth } from '../../src/auth/middleware';
import { createSession, SESSION_COOKIE } from '../../src/auth/sessions';

afterAll(async () => {
  await testPrisma().$disconnect();
});

function adminOnlyApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/admin', requireAuth(testPrisma()), requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireAdmin', () => {
  it('da 403 a un usuario que no es administrador y deja pasar a uno que sí', async () => {
    await resetDb();
    const prisma = testPrisma();
    const app = adminOnlyApp();
    const user = await createUser(prisma, 'user@corre-dominio.com');
    const admin = await prisma.user.update({
      where: { id: (await createUser(prisma, 'jefe@corre-dominio.com')).id },
      data: { isAdmin: true },
    });

    const userToken = await createSession(prisma, user.id);
    const forbidden = await request(app)
      .get('/admin')
      .set('Cookie', `${SESSION_COOKIE}=${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: 'forbidden' });

    const adminToken = await createSession(prisma, admin.id);
    const ok = await request(app).get('/admin').set('Cookie', `${SESSION_COOKIE}=${adminToken}`);
    expect(ok.status).toBe(200);
  });
});
