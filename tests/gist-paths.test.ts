import axios from 'axios';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { gistRouter } from '../src/routes/gist-route';
import { gistPath } from '../src/constants/gist-constants';
import { GistService } from '../src/services/gist-service';

it.each([
  '/..%2Frepos%2Fsecret',
  '/abc%3Fx=y',
  '/abc%23x',
  '/abc/..%2Fsecret',
  '/abc/file/f/compare/abc/..%2Fsecret',
])('rechaza segmentos que cambian la URL de GitHub: %s', async (path) => {
  let calls = 0;
  const client = axios.create({
    adapter: async () => {
      calls++;
      throw new Error('unexpected request');
    },
  });
  const app = express().use(gistRouter(client));
  const res = await request(app).get(path);
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'invalid_input' });
  expect(calls).toBe(0);
});

it('codifica cada segmento enviado por el servicio a GitHub', async () => {
  const urls: string[] = [];
  const client = axios.create({
    adapter: async (config) => {
      urls.push(config.url!);
      return { data: [], status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  await GistService.getCommits(client, 'a/b?c#d');
  await GistService.getCommit(client, 'a/b', 'c/d');
  await GistService.deleteGist(client, 'a/b');
  expect(urls).toEqual(['/a%2Fb%3Fc%23d/commits', '/a%2Fb/c%2Fd', '/a%2Fb']);
  expect(gistPath('abc', 'commits')).toBe('/abc/commits');
});
