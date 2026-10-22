import express from 'express';
import { createSendHandler } from '../controllers/email-controller';
import type { AppDeps } from '../app';

export function emailRouter(deps: Pick<AppDeps, 'mailer'>) {
  const router = express.Router();
  router.post('/send', createSendHandler(deps.mailer));
  return router;
}
