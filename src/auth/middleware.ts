import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '../db/prisma';
import { readSessionToken } from './cookie';
import type { PublicUser } from './public-user';
import { getSessionUser } from './sessions';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. */
    user?: PublicUser;
  }
}

/** Puts the session's user on `req.user`, or answers 401 when there is no valid session. */
export function requireAuth(prisma: PrismaClient): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readSessionToken(req);
      const user = token ? await getSessionUser(prisma, token) : null;
      if (!user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Must run after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
