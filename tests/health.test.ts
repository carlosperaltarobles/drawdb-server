import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers/app';
import { resetDb, testPrisma } from './helpers/db';

afterAll(async () => {
  await testPrisma().$disconnect();
});

describe('base', () => {
  it('GET /api/health responde ok', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('resetDb deja el esquema migrado y vacío', async () => {
    await resetDb();
    expect(await testPrisma().user.count()).toBe(0);
  });
});
