import type { Express } from 'express';
import type { Pool } from 'pg';
import { createApp } from '../../src/app';
import { MemoryMailer } from '../../src/mail/mailer';
import { resetDb, testPool } from './db';

export async function makeApp(): Promise<{ app: Express; pool: Pool; mailer: MemoryMailer }> {
  await resetDb();
  const pool = testPool();
  const mailer = new MemoryMailer();
  const app = createApp({ pool, mailer });
  return { app, pool, mailer };
}
