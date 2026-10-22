import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers/app';
import { testPool } from './helpers/db';

afterAll(async () => {
  await testPool().end();
});

describe('POST /api/email/send', () => {
  it('reenvía los adjuntos al mailer', async () => {
    const { app, mailer } = await makeApp();
    const attachments = [{ filename: 'a.txt', content: 'hola' }];
    const res = await request(app)
      .post('/api/email/send')
      .send({ subject: 'Bug', message: '<p>x</p>', attachments });
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].attachments).toEqual(attachments);
  });

  it('responde 400 sin asunto', async () => {
    const { app, mailer } = await makeApp();
    const res = await request(app).post('/api/email/send').send({ message: 'x' });
    expect(res.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });
});
