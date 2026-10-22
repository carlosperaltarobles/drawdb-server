import type { NextFunction, Request, Response } from 'express';

function clientErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Last middleware: client errors raised by Express itself (malformed JSON, body too large)
 * keep their status; anything else is logged and answered with a generic 500, never a stack.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = clientErrorStatus(err);
  if (status) {
    res.status(status).json({ error: 'invalid_input' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal' });
}
