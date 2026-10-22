import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app';
import type { AppConfig } from '../../src/config';
import type { PrismaClient } from '../../src/db/prisma';
import { MemoryMailer } from '../../src/mail/mailer';
import { resetDb, testPrisma } from './db';

export const ALLOWED_DOMAIN = 'corre-dominio.com';

export const TEST_CONFIG: AppConfig = {
  appUrl: 'http://localhost:5173',
  cookieSecure: false,
  allowedDomains: [ALLOWED_DOMAIN],
  admin: { email: 'admin@admin-dominio.com', password: '' },
  rateLimit: { enabled: false },
};

export type MakeAppOptions = Pick<AppDeps, 'rooms'> & { config?: Partial<AppConfig> };

export async function makeApp(
  opts: MakeAppOptions = {},
): Promise<{ app: Express; prisma: PrismaClient; mailer: MemoryMailer }> {
  await resetDb();
  const prisma = testPrisma();
  const mailer = new MemoryMailer();
  const app = createApp({
    prisma,
    mailer,
    rooms: opts.rooms,
    config: { ...TEST_CONFIG, ...opts.config },
  });
  return { app, prisma, mailer };
}
