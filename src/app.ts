import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'pg';
import { emailRouter } from './routes/email-route';
import { gistRouter } from './routes/gist-route';
import type { Mailer } from './mail/mailer';
import type { CollabHooks } from './collab/hooks';

export type AppDeps = { pool: Pool; mailer: Mailer; rooms?: CollabHooks };

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/email', emailRouter(deps));
  api.use('/gists', gistRouter);
  app.use('/api', api);

  return app;
}
