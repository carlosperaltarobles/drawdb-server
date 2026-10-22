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
const ATTACKER_PASSWORD = 'contraseña-del-atacante';
const body = { email: EMAIL, name: 'Ana', password: PASSWORD };

/** A fresh app where `body` was registered; returns the app and the mailed verify token. */
async function registered() {
  const ctx = await makeApp();
  await request(ctx.app).post('/api/auth/register').send(body);
  await ctx.settle();
  return { ...ctx, token: tokenFromMail(ctx.mailer.sent[0].text, '/verify') };
}

describe('POST /api/auth/register', () => {
  it('rechaza un dominio no permitido sin enviar correo ni revelar el dominio permitido', async () => {
    const { app, mailer, settle } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: 'ana@otro.com' });
    await settle();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'registration_not_allowed' });
    expect(res.text).not.toContain(ALLOWED_DOMAIN);
    expect(mailer.sent).toHaveLength(0);
  });

  it('comprueba el dominio antes que el resto de campos', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ana@otro.com', name: '', password: 'corta' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'registration_not_allowed' });
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
    const { app, prisma, mailer, settle } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: ` Ana@${ALLOWED_DOMAIN.toUpperCase()} ` });
    await settle();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(EMAIL);
    expect(mailer.sent[0].text).toContain('http://localhost:5173/verify?token=');
  });

  it('con un correo ya verificado responde igual, no crea usuario y avisa por correo', async () => {
    const { app, prisma, mailer, settle } = await makeApp();
    await createUser(prisma, EMAIL);
    const res = await request(app).post('/api/auth/register').send(body);
    await settle();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    expect(await prisma.user.count()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe('Ya tienes una cuenta — drawDB');
    expect(mailer.sent[0].text).toContain('http://localhost:5173/forgot');
  });

  it('con un correo sin verificar invalida los tokens anteriores y cambia la contraseña', async () => {
    const { app, prisma, mailer, settle, token: oldToken } = await registered();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, password: 'otra-contraseña-nueva' });
    await settle();
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(2);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await verifyPassword(user.passwordHash, 'otra-contraseña-nueva')).toBe(true);
    const old = await request(app)
      .post('/api/auth/verify')
      .send({ token: oldToken, password: 'otra-contraseña-nueva' });
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ error: 'invalid_token' });
  });

  it('el correo del administrador no está exento del filtro de dominios', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, email: 'admin@admin-dominio.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'registration_not_allowed' });
  });
});

describe('POST /api/auth/verify', () => {
  it('rechaza un token caducado', async () => {
    const { app, prisma, token } = await registered();
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/auth/verify').send({ token, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  it('con una contraseña incorrecta da 400 sin gastar el token', async () => {
    const { app, prisma, token } = await registered();
    const res = await request(app)
      .post('/api/auth/verify')
      .send({ token, password: 'contraseña-mala' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_token' });
    expect(await prisma.session.count()).toBe(0);

    const retry = await request(app).post('/api/auth/verify').send({ token, password: PASSWORD });
    expect(retry.status).toBe(200);
  });

  it('verifica, inicia sesión y no deja reutilizar el token', async () => {
    const { app, prisma, token } = await registered();
    const res = await request(app).post('/api/auth/verify').send({ token, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, name: 'Ana', isAdmin: false });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^drawdb_session=[\w-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const again = await request(app).post('/api/auth/verify').send({ token, password: PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'invalid_token' });
  });

  it('quien re-registra una cuenta pendiente ajena no consigue que la verifique su dueña', async () => {
    const { app, mailer, settle } = await registered();
    await request(app)
      .post('/api/auth/register')
      .send({ ...body, password: ATTACKER_PASSWORD });
    await settle();
    const attackerToken = tokenFromMail(mailer.sent[1].text, '/verify');
    const victim = await request(app)
      .post('/api/auth/verify')
      .send({ token: attackerToken, password: PASSWORD });
    expect(victim.status).toBe(400);

    await request(app).post('/api/auth/register').send(body);
    await settle();
    const token = tokenFromMail(mailer.sent[2].text, '/verify');
    const verified = await request(app)
      .post('/api/auth/verify')
      .send({ token, password: PASSWORD });
    expect(verified.status).toBe(200);

    const attacker = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: ATTACKER_PASSWORD });
    expect(attacker.status).toBe(401);
  });
});

describe('POST /api/auth/resend', () => {
  it('responde 202 siempre y solo envía a cuentas sin verificar', async () => {
    const { app, prisma, mailer, settle } = await makeApp();
    await createUser(prisma, `vera@${ALLOWED_DOMAIN}`);
    await createUser(prisma, `nora@${ALLOWED_DOMAIN}`, { verified: false });

    for (const email of [`vera@${ALLOWED_DOMAIN}`, `nadie@${ALLOWED_DOMAIN}`, 'no-es-correo']) {
      const res = await request(app).post('/api/auth/resend').send({ email });
      expect(res.status).toBe(202);
    }
    await settle();
    expect(mailer.sent).toHaveLength(0);

    const res = await request(app)
      .post('/api/auth/resend')
      .send({ email: `nora@${ALLOWED_DOMAIN}` });
    await settle();
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain('/verify?token=');
  });

  it('responde sin esperar al envío del correo', async () => {
    const { app, prisma, mailer, settle } = await makeApp();
    await createUser(prisma, `nora@${ALLOWED_DOMAIN}`, { verified: false });
    const res = await request(app)
      .post('/api/auth/resend')
      .send({ email: `nora@${ALLOWED_DOMAIN}` });
    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
    await settle();
    expect(mailer.sent).toHaveLength(1);
  });
});
