import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_DOMAIN, makeApp } from './helpers/app';
import { testPrisma } from './helpers/db';
import { createUser, sessionCookie } from './helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

async function signedIn(opts: Parameters<typeof makeApp>[0] = {}) {
  const ctx = await makeApp(opts);
  const user = await createUser(ctx.prisma, `ana@${ALLOWED_DOMAIN}`);
  return { ...ctx, cookie: await sessionCookie(ctx.prisma, user.id) };
}

describe('POST /api/email/send', () => {
  it('pide sesión', async () => {
    const { app, mailer } = await makeApp();
    const res = await request(app).post('/api/email/send').send({ subject: 'Bug', message: 'x' });
    expect(res.status).toBe(401);
    expect(mailer.sent).toHaveLength(0);
  });

  it('reenvía los adjuntos al mailer', async () => {
    const { app, mailer, cookie } = await signedIn();
    const attachments = [
      { filename: 'a.txt', content: 'hola' },
      { filename: 'b.png', content: 'iVBORw0KGgo=', encoding: 'base64', contentType: 'image/png' },
    ];
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({ subject: 'Bug', message: '<p>x</p>', attachments });
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].attachments).toEqual(attachments);
  });

  it('acepta 5 MiB reales codificados en base64', async () => {
    const { app, mailer, cookie } = await signedIn();
    const content = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({
        subject: 'Bug',
        message: 'x',
        attachments: [{ filename: 'a.bin', content, encoding: 'base64' }],
      });
    expect(res.status).toBe(200);
    expect(mailer.sent[0].attachments?.[0].content).toBe(content);
  });

  it.each(['base64', 'utf8'])('rechaza más de 5 MiB reales en %s', async (encoding) => {
    const { app, mailer, cookie } = await signedIn();
    const content =
      encoding === 'base64'
        ? Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
        : 'é'.repeat((5 * 1024 * 1024) / 2 + 1);
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({
        subject: 'Bug',
        message: 'x',
        attachments: [
          { filename: 'a.bin', content, ...(encoding === 'base64' ? { encoding } : {}) },
        ],
      });
    expect(res.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it('suma el tamaño real de todos los adjuntos', async () => {
    const { app, mailer, cookie } = await signedIn();
    const content = Buffer.alloc(Math.ceil(2.6 * 1024 * 1024)).toString('base64');
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({
        subject: 'Bug',
        message: 'x',
        attachments: [1, 2].map((i) => ({ filename: `${i}.bin`, content, encoding: 'base64' })),
      });
    expect(res.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it.each(['!!!!', 'Zg=', 'Zg===', 'Z g=='])('rechaza base64 inválido: %s', async (content) => {
    const { app, mailer, cookie } = await signedIn();
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({
        subject: 'Bug',
        message: 'x',
        attachments: [{ filename: 'a.bin', content, encoding: 'base64' }],
      });
    expect(res.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it('responde 400 sin asunto', async () => {
    const { app, mailer, cookie } = await signedIn();
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({ message: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_input' });
    expect(mailer.sent).toHaveLength(0);
  });

  it.each([
    ['path', { filename: 'a', path: '/etc/passwd' }],
    ['href', { filename: 'a', href: 'http://169.254.169.254/' }],
    ['raw', { raw: 'Content-Type: text/plain\r\n\r\nx' }],
    ['una clave desconocida', { filename: 'a', content: 'x', cid: 'y' }],
    ['un encoding distinto de base64', { filename: 'a', content: 'x', encoding: 'hex' }],
  ])('rechaza un adjunto con %s y no envía nada', async (_case, attachment) => {
    const { app, mailer, cookie } = await signedIn();
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({ subject: 'Bug', message: 'x', attachments: [attachment] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_input' });
    expect(mailer.sent).toHaveLength(0);
  });

  it('rechaza más de 5 adjuntos', async () => {
    const { app, mailer, cookie } = await signedIn();
    const attachments = Array.from({ length: 6 }, (_, i) => ({ filename: `${i}`, content: 'x' }));
    const res = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({ subject: 'Bug', message: 'x', attachments });
    expect(res.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('/api/gists', () => {
  it('pide sesión', async () => {
    const { app } = await makeApp({ config: { githubToken: 'token' } });
    const res = await request(app).get('/api/gists/x');
    expect(res.status).toBe(401);
  });

  it('sin GITHUB_TOKEN responde 503 gists_disabled', async () => {
    const { app, cookie } = await signedIn({ config: { githubToken: undefined } });
    const res = await request(app).get('/api/gists/x').set('Cookie', cookie);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'gists_disabled' });
  });
});
