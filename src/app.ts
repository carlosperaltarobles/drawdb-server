import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { PrismaClient } from './db/prisma';
import { emailRouter } from './routes/email-route';
import { gistRouter } from './routes/gist-route';
import type { Mailer } from './mail/mailer';
import type { CollabHooks } from './collab/hooks';
import type { AppConfig } from './config';
import { authRouter } from './auth/routes';
import { requireAuth } from './auth/middleware';
import { projectsRouter } from './projects/routes';
import { adminRouter } from './admin/routes';
import type { RunInBackground } from './http/background';
import { errorHandler } from './http/error-handler';

export type AppDeps = {
  prisma: PrismaClient;
  mailer: Mailer;
  config: AppConfig;
  /** Where work that must not delay the response runs (tests inject one they can await). */
  runInBackground: RunInBackground;
  rooms?: CollabHooks;
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter(deps));
  api.use('/projects', projectsRouter(deps));
  api.use('/admin', adminRouter(deps));
  api.use('/email', requireAuth(deps.prisma), emailRouter(deps));
  api.use('/gists', requireAuth(deps.prisma), gistRouter(deps.config.githubToken));
  app.use('/api', api);
  app.use(errorHandler);

  return app;
}
