import type { Request, Response } from 'express';
import { SESSION_COOKIE, SESSION_TTL_MS } from './sessions';

export function readSessionToken(req: Request): string | undefined {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' && token ? token : undefined;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure });
}
