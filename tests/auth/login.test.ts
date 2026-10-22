import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, PASSWORD } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const EMAIL = `luis@${ALLOWED_DOMAIN}`;

describe('POST /api/auth/login', () => {
  it('rechaza a un usuario sin verificar', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL, { verified: false });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('una contraseña mala o un usuario inexistente dan la misma respuesta', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL);
    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'contraseña-mala' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'invalid_credentials' });
    const missing = await request(app)
      .post('/api/auth/login')
      .send({ email: `nadie@${ALLOWED_DOMAIN}`, password: PASSWORD });
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual(bad.body);
  });

  it('login correcto fija la cookie y GET /me devuelve el usuario; logout la invalida', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL);
    const agent = request.agent(app);

    const login = await agent
      .post('/api/auth/login')
      .send({ email: ` ${EMAIL.toUpperCase()}`, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: EMAIL, isAdmin: false, isSuperadmin: false });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(login.body.user);
    expect(Object.keys(me.body.user).sort()).toEqual(
      ['email', 'id', 'isAdmin', 'isSuperadmin', 'name'].sort(),
    );

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(204);
    expect(await prisma.session.count()).toBe(0);
    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: 'unauthorized' });
  });

  it('una sesión caducada no autentica', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('con rate limit activo, el intento 11 con el mismo correo da 429 aunque cambie la IP', async () => {
    const { app } = await makeApp({ config: { rateLimit: { enabled: true } } });
    const attempt = (i: number) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ email: EMAIL, password: 'contraseña-mala' });
    for (let i = 1; i <= 10; i++) {
      expect((await attempt(i)).status).toBe(401);
    }
    const res = await attempt(11);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'too_many_requests' });
  });

  it('con rate limit activo, el intento 11 desde la misma IP da 429 aunque cambie el correo', async () => {
    const { app } = await makeApp({ config: { rateLimit: { enabled: true } } });
    const attempt = (i: number) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ email: `u${i}@${ALLOWED_DOMAIN}`, password: 'contraseña-mala' });
    for (let i = 1; i <= 10; i++) {
      expect((await attempt(i)).status).toBe(401);
    }
    expect((await attempt(11)).status).toBe(429);
  });
});

describe('POST /api/auth/password', () => {
  it('exige sesión', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'nueva-contraseña' });
    expect(res.status).toBe(401);
  });

  it('rechaza una contraseña actual incorrecta', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    const res = await agent
      .post('/api/auth/password')
      .send({ currentPassword: 'contraseña-mala', newPassword: 'nueva-contraseña' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('cambia la contraseña, conserva la sesión actual y cierra las demás', async () => {
    const { app, prisma } = await makeApp();
    await createUser(prisma, EMAIL);
    const current = request.agent(app);
    const other = request.agent(app);
    await current.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    await other.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });

    const res = await current
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'nueva-contraseña' });
    expect(res.status).toBe(204);
    expect((await current.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'nueva-contraseña' });
    expect(login.status).toBe(200);
  });
});
