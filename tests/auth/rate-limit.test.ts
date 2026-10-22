import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';

afterAll(async () => {
  await testPrisma().$disconnect();
});

describe('límites por IP', () => {
  it.each(['register', 'verify', 'resend', 'forgot', 'reset'])(
    'POST /api/auth/%s admite 5 intentos cada 15 min por IP',
    async (path) => {
      const { app, settle } = await makeApp({ config: { rateLimit: { enabled: true } } });
      const attempt = () => request(app).post(`/api/auth/${path}`).send({});
      for (let i = 0; i < 5; i++) {
        expect((await attempt()).status).not.toBe(429);
      }
      const res = await attempt();
      await settle();
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'too_many_requests' });
    },
  );
});
