import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { config as serverConfig } from '../src/config';
import { GistService } from '../src/services/gist-service';
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

  it('no filtra config.mail.username en la respuesta HTTP', async () => {
    const prevUsername = serverConfig.mail.username;
    serverConfig.mail.username = 'secret-smtp-user@internal.example.com';
    try {
      const { app, cookie } = await signedIn();
      const res = await request(app)
        .post('/api/email/send')
        .set('Cookie', cookie)
        .send({ subject: 'Bug', message: 'Hola' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Email successfully sent!',
      });
      expect(JSON.stringify(res.body)).not.toContain(serverConfig.mail.username);
    } finally {
      serverConfig.mail.username = prevUsername;
    }
  });

  it('aplica rate limit en POST /api/email/send (429 tras 5 intentos)', async () => {
    const { app, cookie } = await signedIn({ config: { rateLimit: { enabled: true } } });
    for (let i = 1; i <= 5; i++) {
      const res = await request(app)
        .post('/api/email/send')
        .set('Cookie', cookie)
        .send({ subject: `Bug ${i}`, message: 'x' });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post('/api/email/send')
      .set('Cookie', cookie)
      .send({ subject: 'Bug 6', message: 'x' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'too_many_requests' });
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

  it('espera a GistService.deleteGist en DELETE y PATCH y responde 500 si falla upstream', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deleteSpy = vi
      .spyOn(GistService, 'deleteGist')
      .mockRejectedValue(new Error('upstream failure'));
    try {
      const { app, cookie } = await signedIn({ config: { githubToken: 'token' } });

      const delRes = await request(app).delete('/api/gists/abc123').set('Cookie', cookie);
      expect(delRes.status).toBe(500);
      expect(delRes.body).toEqual({ success: false, message: 'Something went wrong' });

      // Simulate PATCH where upstream returns empty files {}, triggering GistService.deleteGist
      const axios = await import('axios');
      const patchSpy = vi
        .spyOn(axios.Axios.prototype, 'patch')
        .mockResolvedValue({ data: { files: {} } });
      try {
        const patchRes = await request(app)
          .patch('/api/gists/abc123')
          .set('Cookie', cookie)
          .send({ description: 'x', files: {} });
        expect(patchRes.status).toBe(500);
        expect(patchRes.body).toEqual({ success: false, message: 'Something went wrong' });
      } finally {
        patchSpy.mockRestore();
      }
    } finally {
      deleteSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('limita la paginación de commits a un máximo de 5 páginas cuando upstream devuelve 100 elementos por página', async () => {
    const commitsPage = Array.from({ length: 100 }, (_, i) => ({
      version: `v-${i}`,
      committed_at: '2025-01-01T00:00:00Z',
      change_status: { total: 1, additions: 1, deletions: 0 },
      user: {},
      url: 'https://api.github.com/gists/abc/v',
    }));
    let calls = 0;
    const getCommitsSpy = vi.spyOn(GistService, 'getCommits').mockImplementation(async () => {
      calls++;
      return calls <= 10 ? commitsPage : [];
    });
    const getCommitSpy = vi.spyOn(GistService, 'getCommit').mockResolvedValue({ files: {} });
    try {
      const { app, cookie } = await signedIn({ config: { githubToken: 'token' } });
      const res = await request(app)
        .get('/api/gists/abc123/file-versions/diagram.json')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(getCommitsSpy).toHaveBeenCalledTimes(5);
    } finally {
      getCommitsSpy.mockRestore();
      getCommitSpy.mockRestore();
    }
  });
});
