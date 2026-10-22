import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers/app';
import { resetDb, testPool } from './helpers/db';

afterAll(async () => {
  await testPool().end();
});

describe('base', () => {
  it('GET /api/health responde ok', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('resetDb deja el esquema migrado', async () => {
    await resetDb();
    const { rows } = await testPool().query(`select to_regclass('users') as t`);
    expect(rows[0].t).not.toBeNull();
  });
});
