import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, PASSWORD, tokenFromMail } from '../helpers/users';
import { verifyPassword } from '../../src/auth/passwords';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const EMAIL = `ana@${ALLOWED_DOMAIN}`;
const body = { email: EMAIL, name: 'Ana', password: PASSWORD };

describe('POST /api/auth/register', () => {
  it('rechaza un dominio no permitido sin enviar correo ni revelar el dominio permitido', async () => {
    const { app, mailer } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: 'ana@otro.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'registration_not_allowed' });
    expect(res.text).not.toContain(ALLOWED_DOMAIN);
    expect(mailer.sent).toHaveLength(0);
  });

  it('rechaza una entrada inválida', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, password: 'corta' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_input' });
  });

  it('con un dominio permitido crea el usuario sin verificar y envía el enlace', async () => {
    const { app, prisma, mailer } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: ` Ana@${ALLOWED_DOMAIN.toUpperCase()} ` });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(EMAIL);
    expect(mailer.sent[0].text).toContain('http://localhost:5173/verify?token=');
  });

  it('con un correo ya verificado responde igual, no crea usuario y avisa por correo', async () => {
    const { app, prisma, mailer } = await makeApp();
    await createUser(prisma, EMAIL);
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    expect(await prisma.user.count()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe('Ya tienes una cuenta — drawDB');
    expect(mailer.sent[0].text).toContain('http://localhost:5173/forgot');
  });

  it('con un correo sin verificar invalida los tokens anteriores y cambia la contraseña', async () => {
    const { app, prisma, mailer } = await makeApp();
    await request(app).post('/api/auth/register').send(body);
    const oldToken = tokenFromMail(mailer.sent[0].text, '/verify');

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, password: 'otra-contraseña-nueva' });
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(2);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await verifyPassword(user.passwordHash, 'otra-contraseña-nueva')).toBe(true);
    const old = await request(app).post('/api/auth/verify').send({ token: oldToken });
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ error: 'invalid_token' });
  });

  it('el ADMIN_EMAIL puede registrarse aunque su dominio no esté permitido', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: 'admin@admin-dominio.com' });
    expect(res.status).toBe(202);
  });
});

describe('POST /api/auth/verify', () => {
  it('rechaza un token caducado', async () => {
    const { app, prisma, mailer } = await makeApp();
    await request(app).post('/api/auth/register').send(body);
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const token = tokenFromMail(mailer.sent[0].text, '/verify');
    const res = await request(app).post('/api/auth/verify').send({ token });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  it('verifica, inicia sesión y no deja reutilizar el token', async () => {
    const { app, prisma, mailer } = await makeApp();
    await request(app).post('/api/auth/register').send(body);
    const token = tokenFromMail(mailer.sent[0].text, '/verify');

    const res = await request(app).post('/api/auth/verify').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, name: 'Ana', isAdmin: false });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^drawdb_session=[\w-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const again = await request(app).post('/api/auth/verify').send({ token });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'invalid_token' });
  });
});

describe('POST /api/auth/resend', () => {
  it('responde 202 siempre y solo envía a cuentas sin verificar', async () => {
    const { app, prisma, mailer } = await makeApp();
    await createUser(prisma, `vera@${ALLOWED_DOMAIN}`);
    await createUser(prisma, `nora@${ALLOWED_DOMAIN}`, { verified: false });

    for (const email of [`vera@${ALLOWED_DOMAIN}`, `nadie@${ALLOWED_DOMAIN}`, 'no-es-correo']) {
      const res = await request(app).post('/api/auth/resend').send({ email });
      expect(res.status).toBe(202);
    }
    expect(mailer.sent).toHaveLength(0);

    const res = await request(app)
      .post('/api/auth/resend')
      .send({ email: `nora@${ALLOWED_DOMAIN}` });
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain('/verify?token=');
  });
});
