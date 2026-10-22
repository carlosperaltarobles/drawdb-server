import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createSendHandler } from '../controllers/email-controller';
import type { AppDeps } from '../app';
import { asyncHandler } from '../http/async-handler';

const WINDOW_MS = 15 * 60 * 1000;
const allow: RequestHandler = (_req, _res, next) => next();

export function emailRouter(deps: Pick<AppDeps, 'mailer' | 'config'>) {
  const router = express.Router();
  const sendLimiter: RequestHandler = deps.config.rateLimit.enabled
    ? rateLimit({ windowMs: WINDOW_MS, limit: 5, message: { error: 'too_many_requests' } })
    : allow;
  router.post('/send', sendLimiter, asyncHandler(createSendHandler(deps.mailer)));
  return router;
}
