import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app';
import type { AppConfig } from '../../src/config';
import type { PrismaClient } from '../../src/db/prisma';
import { MemoryMailer } from '../../src/mail/mailer';
import { BackgroundTasks } from './background';
import { resetDb, testPrisma } from './db';

export const ALLOWED_DOMAIN = 'corre-dominio.com';

export const TEST_CONFIG: AppConfig = {
  appUrl: 'http://localhost:5173',
  cookieSecure: false,
  allowedDomains: [ALLOWED_DOMAIN],
  rateLimit: { enabled: false },
};

export type MakeAppOptions = Pick<AppDeps, 'rooms'> & { config?: Partial<AppConfig> };

export async function makeApp(opts: MakeAppOptions = {}): Promise<{
  app: Express;
  prisma: PrismaClient;
  mailer: MemoryMailer;
  /** Waits for the background work (mails, registrations) started by the requests so far. */
  settle: () => Promise<void>;
}> {
  await resetDb();
  const prisma = testPrisma();
  const mailer = new MemoryMailer();
  const background = new BackgroundTasks();
  const app = createApp({
    prisma,
    mailer,
    rooms: opts.rooms,
    config: { ...TEST_CONFIG, ...opts.config },
    runInBackground: background.run,
  });
  return { app, prisma, mailer, settle: () => background.settle() };
}
