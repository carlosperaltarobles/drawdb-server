import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { PrismaClient } from './db/prisma';
import { emailRouter } from './routes/email-route';
import { gistRouter } from './routes/gist-route';
import { createGistClient } from './constants/gist-constants';
import type { Mailer } from './mail/mailer';
import type { CollabHooks } from './collab/hooks';
import type { HistoryRooms } from './history/types';
import type { AppConfig } from './config';
import { authRouter } from './auth/routes';
import { requireAuth } from './auth/middleware';
import { historyRouter } from './history/routes';
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
  history?: HistoryRooms;
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());

  const { githubToken } = deps.config;
  const api = express.Router();
  // A 5 MiB attachment needs about 6.67 MiB in base64 plus JSON overhead.
  // Authenticate before accepting the larger email body.
  api.use('/email', requireAuth(deps.prisma), express.json({ limit: '8mb' }), emailRouter(deps));
  api.use(express.json({ limit: '1mb' }));
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter(deps));
  if (deps.history) {
    api.use('/projects/:id/history', historyRouter(deps));
  }
  api.use('/projects', projectsRouter(deps));
  api.use('/admin', adminRouter(deps));
  api.use(
    '/gists',
    requireAuth(deps.prisma),
    gistRouter(githubToken ? createGistClient(githubToken) : undefined),
  );
  app.use('/api', api);
  app.use(errorHandler);

  return app;
}
