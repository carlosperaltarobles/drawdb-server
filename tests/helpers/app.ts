import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app';
import type { PrismaClient } from '../../src/db/prisma';
import { MemoryMailer } from '../../src/mail/mailer';
import { resetDb, testPrisma } from './db';

export async function makeApp(
  opts: Pick<AppDeps, 'rooms'> = {},
): Promise<{ app: Express; prisma: PrismaClient; mailer: MemoryMailer }> {
  await resetDb();
  const prisma = testPrisma();
  const mailer = new MemoryMailer();
  const app = createApp({ prisma, mailer, ...opts });
  return { app, prisma, mailer };
}
