import express from 'express';
import { createSendHandler } from '../controllers/email-controller';
import type { AppDeps } from '../app';
import { asyncHandler } from '../http/async-handler';

export function emailRouter(deps: Pick<AppDeps, 'mailer'>) {
  const router = express.Router();
  router.post('/send', asyncHandler(createSendHandler(deps.mailer)));
  return router;
}
