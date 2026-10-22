import express from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { requireAdmin, requireAuth } from '../auth/middleware';
import { asyncHandler } from '../http/async-handler';
import { parse } from '../http/validate';
import { AdminUsersService } from './users-service';

const userParams = z.object({ id: z.uuid() });
const setAdminSchema = z.object({ isAdmin: z.boolean() });

export function adminRouter({ prisma, rooms }: AppDeps) {
  const users = new AdminUsersService({ prisma, rooms });
  const router = express.Router();
  router.use(requireAuth(prisma), requireAdmin);

  router.get(
    '/users',
    asyncHandler(async (_req, res) => {
      res.json(await users.list());
    }),
  );

  router.patch(
    '/users/:id',
    asyncHandler(async (req, res) => {
      const { id } = parse(userParams, req.params);
      const { isAdmin } = parse(setAdminSchema, req.body);
      res.json(await users.setAdmin(id, isAdmin));
    }),
  );

  return router;
}
