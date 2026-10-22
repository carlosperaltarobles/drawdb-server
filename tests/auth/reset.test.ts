import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, PASSWORD, tokenFromMail } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const EMAIL = `rosa@${ALLOWED_DOMAIN}`;
const NEW_PASSWORD = 'contraseña-renovada';

describe('POST /api/auth/forgot', () => {
  it('con un correo inexistente responde 202 sin enviar nada', async () => {
    const { app, mailer } = await makeApp();
    const res = await request(app).post('/api/auth/forgot').send({ email: EMAIL });
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
  });

  it('con un correo existente responde 202 y envía el enlace', async () => {
    const { app, prisma, mailer } = await makeApp();
    await createUser(prisma, EMAIL);
    const res = await request(app).post('/api/auth/forgot').send({ email: EMAIL });
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain('http://localhost:5173/reset?token=');
  });
});

describe('POST /api/auth/reset', () => {
  it('con un token válido cambia la contraseña y cierra las sesiones previas', async () => {
    const { app, prisma, mailer } = await makeApp();
    await createUser(prisma, EMAIL);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    await request(app).post('/api/auth/forgot').send({ email: EMAIL });
    const token = tokenFromMail(mailer.sent[0].text, '/reset');

    const res = await request(app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(204);
    expect(await prisma.session.count()).toBe(0);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    const again = await request(app)
      .post('/api/auth/reset')
      .send({ token, password: NEW_PASSWORD });
    expect(again.status).toBe(400);
  });

  it('rechaza un token de más de 1 h', async () => {
    const { app, prisma, mailer } = await makeApp();
    await createUser(prisma, EMAIL);
    await request(app).post('/api/auth/forgot').send({ email: EMAIL });
    const token = tokenFromMail(mailer.sent[0].text, '/reset');
    const stored = await prisma.emailToken.findFirstOrThrow();
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  it('no acepta un token de verificación como token de reset', async () => {
    const { app, mailer } = await makeApp();
    await request(app)
      .post('/api/auth/register')
      .send({ email: EMAIL, name: 'Rosa', password: PASSWORD });
    const token = tokenFromMail(mailer.sent[0].text, '/verify');
    const res = await request(app).post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });
});
