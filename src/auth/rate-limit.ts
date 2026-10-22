import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config';
import { normalizeEmail } from './domain';

const WINDOW_MS = 15 * 60 * 1000;
const tooManyRequests = { error: 'too_many_requests' };

export type AuthLimiters = {
  register: RequestHandler;
  verify: RequestHandler;
  reset: RequestHandler;
  resend: RequestHandler;
  forgot: RequestHandler;
  login: RequestHandler[];
};

const allow: RequestHandler = (_req, _res, next) => next();

function perIp(limit: number): RequestHandler {
  return rateLimit({ windowMs: WINDOW_MS, limit, message: tooManyRequests });
}

function perEmail(limit: number): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    message: tooManyRequests,
    keyGenerator: (req) => `email:${normalizeEmail(String(req.body?.email ?? ''))}`,
  });
}

/** One limiter per endpoint, so each app instance (and each test) gets its own counters. */
export function authLimiters(cfg: Pick<AppConfig, 'rateLimit'>): AuthLimiters {
  if (!cfg.rateLimit.enabled) {
    return {
      register: allow,
      verify: allow,
      reset: allow,
      resend: allow,
      forgot: allow,
      login: [allow],
    };
  }
  return {
    register: perIp(5),
    verify: perIp(5),
    reset: perIp(5),
    resend: perIp(5),
    forgot: perIp(5),
    login: [perIp(10), perEmail(10)],
  };
}
