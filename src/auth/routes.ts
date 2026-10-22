import express, { type Response } from 'express';
import type { AppDeps } from '../app';
import { asyncHandler } from '../http/async-handler';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './cookie';
import { requireAuth } from './middleware';
import { authLimiters } from './rate-limit';
import {
  changePasswordSchema,
  emailSchema,
  loginSchema,
  registerSchema,
  resetSchema,
  verifySchema,
} from './schemas';
import { AuthService, type SignedIn } from './service';

function invalidInput(res: Response): void {
  res.status(400).json({ error: 'invalid_input' });
}

export function authRouter({ prisma, mailer, config, runInBackground }: AppDeps) {
  const auth = new AuthService({ prisma, mailer, config, runInBackground });
  const limit = authLimiters(config);
  const router = express.Router();

  const signedIn = (res: Response, { user, sessionToken }: SignedIn) => {
    setSessionCookie(res, sessionToken, config.cookieSecure);
    res.json({ user });
  };

  // The domain is checked before the other fields, so a non-allowed email always gets the
  // same answer whatever else was sent.
  router.post('/register', limit.register, (req, res) => {
    const email = emailSchema.safeParse(req.body);
    if (email.success && !auth.isRegistrationAllowed(email.data.email)) {
      res.status(400).json({ error: 'registration_not_allowed' });
      return;
    }
    const input = registerSchema.safeParse(req.body);
    if (!input.success) return invalidInput(res);
    res.status(202).json({ status: auth.register(input.data) });
  });

  // Any failure, including a wrong password, is reported as an invalid token.
  router.post(
    '/verify',
    limit.verify,
    asyncHandler(async (req, res) => {
      const input = verifySchema.safeParse(req.body);
      const result = input.success
        ? await auth.verify(input.data.token, input.data.password)
        : null;
      if (!result) {
        res.status(400).json({ error: 'invalid_token' });
        return;
      }
      signedIn(res, result);
    }),
  );

  // resend and forgot always answer 202, even for malformed input, so the response says
  // nothing about the account.
  router.post('/resend', limit.resend, (req, res) => {
    const input = emailSchema.safeParse(req.body);
    if (input.success) auth.resendVerification(input.data.email);
    res.status(202).end();
  });

  router.post(
    '/login',
    ...limit.login,
    asyncHandler(async (req, res) => {
      const input = loginSchema.safeParse(req.body);
      if (!input.success) return invalidInput(res);
      const result = await auth.login(input.data.email, input.data.password);
      if (!result) {
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      signedIn(res, result);
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = readSessionToken(req);
      if (token) await auth.logout(token);
      clearSessionCookie(res, config.cookieSecure);
      res.status(204).end();
    }),
  );

  router.get('/me', requireAuth(prisma), (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/forgot', limit.forgot, (req, res) => {
    const input = emailSchema.safeParse(req.body);
    if (input.success) auth.requestPasswordReset(input.data.email);
    res.status(202).end();
  });

  router.post(
    '/reset',
    limit.reset,
    asyncHandler(async (req, res) => {
      const input = resetSchema.safeParse(req.body);
      if (!input.success) return invalidInput(res);
      if (!(await auth.resetPassword(input.data.token, input.data.password))) {
        res.status(400).json({ error: 'invalid_token' });
        return;
      }
      res.status(204).end();
    }),
  );

  router.post(
    '/password',
    requireAuth(prisma),
    asyncHandler(async (req, res) => {
      const input = changePasswordSchema.safeParse(req.body);
      if (!input.success) return invalidInput(res);
      const { currentPassword, newPassword } = input.data;
      // requireAuth guarantees both the user and the session cookie.
      const changed = await auth.changePassword(
        req.user!.id,
        readSessionToken(req)!,
        currentPassword,
        newPassword,
      );
      if (!changed) {
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      res.status(204).end();
    }),
  );

  return router;
}
