import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/http/error-handler';

function appThatThrows(err: unknown) {
  const app = express();
  app.use(express.json());
  app.post('/boom', () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('responde 500 en JSON sin stack y registra el error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(new Error('secreto interno'))).post('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(res.text).not.toContain('secreto interno');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('un JSON mal formado da 400 invalid_input', async () => {
    const res = await request(appThatThrows(new Error('no llega')))
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send('{"roto"');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_input' });
  });
});
