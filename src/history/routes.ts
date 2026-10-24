import express from 'express';
import type { AppDeps } from '../app';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../http/async-handler';
import { parse } from '../http/validate';
import { listQuerySchema, projectParams, snapshotNameSchema, snapshotParams } from './schemas';
import { HistoryService } from './service';

// requireAuth runs first on every route, so req.user is always set.
export function historyRouter({ prisma, history }: AppDeps) {
  if (!history) {
    throw new Error('historyRouter requires deps.history');
  }
  const service = new HistoryService({ prisma, history });
  const router = express.Router({ mergeParams: true });
  router.use(requireAuth(prisma));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      const query = parse(listQuerySchema, req.query);
      res.json(await service.list(id, req.user!, query));
    }),
  );

  router.get(
    '/:snapshotId',
    asyncHandler(async (req, res) => {
      const { id, snapshotId } = parse(snapshotParams, req.params);
      res.json(await service.get(id, snapshotId, req.user!));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      const { name } = parse(snapshotNameSchema, req.body);
      res.status(201).json(await service.create(id, name, req.user!));
    }),
  );

  router.patch(
    '/:snapshotId',
    asyncHandler(async (req, res) => {
      const { id, snapshotId } = parse(snapshotParams, req.params);
      const { name } = parse(snapshotNameSchema, req.body);
      res.json(await service.rename(id, snapshotId, name, req.user!));
    }),
  );

  router.delete(
    '/:snapshotId',
    asyncHandler(async (req, res) => {
      const { id, snapshotId } = parse(snapshotParams, req.params);
      await service.remove(id, snapshotId, req.user!);
      res.status(204).end();
    }),
  );

  router.post(
    '/:snapshotId/restore',
    asyncHandler(async (req, res) => {
      const { id, snapshotId } = parse(snapshotParams, req.params);
      res.json(await service.restore(id, snapshotId, req.user!));
    }),
  );

  return router;
}
