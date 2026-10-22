import express from 'express';
import type { AppDeps } from '../app';
import { requireAdmin, requireAuth } from '../auth/middleware';
import { asyncHandler } from '../http/async-handler';
import { parse } from '../http/validate';
import { MembersService } from './members-service';
import {
  addMemberSchema,
  invitationParams,
  memberParams,
  memberRoleSchema,
  projectNameSchema,
  projectParams,
} from './schemas';
import { ProjectsService } from './service';

// requireAuth runs first on every route, so req.user is always set.
export function projectsRouter({ prisma, mailer, config, runInBackground, rooms }: AppDeps) {
  const projects = new ProjectsService({ prisma, rooms });
  const members = new MembersService({ prisma, mailer, config, runInBackground, rooms });
  const router = express.Router();
  router.use(requireAuth(prisma));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await projects.list(req.user!));
    }),
  );

  router.post(
    '/',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name } = parse(projectNameSchema, req.body);
      res.status(201).json(await projects.create(name, req.user!));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      res.json(await projects.get(id, req.user!));
    }),
  );

  router.patch(
    '/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      const { name } = parse(projectNameSchema, req.body);
      res.json(await projects.rename(id, name));
    }),
  );

  router.delete(
    '/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      await projects.remove(id);
      res.status(204).end();
    }),
  );

  router.get(
    '/:id/members',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      res.json(await members.list(id));
    }),
  );

  router.post(
    '/:id/members',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = parse(projectParams, req.params);
      const { email, role } = parse(addMemberSchema, req.body);
      res.json({ status: await members.add(id, email, role, req.user!) });
    }),
  );

  router.patch(
    '/:id/members/:userId',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id, userId } = parse(memberParams, req.params);
      const { role } = parse(memberRoleSchema, req.body);
      await members.changeRole(id, userId, role);
      res.json({ userId, role });
    }),
  );

  router.delete(
    '/:id/members/:userId',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id, userId } = parse(memberParams, req.params);
      await members.remove(id, userId);
      res.status(204).end();
    }),
  );

  router.delete(
    '/:id/invitations/:invId',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id, invId } = parse(invitationParams, req.params);
      await members.cancelInvitation(id, invId);
      res.status(204).end();
    }),
  );

  return router;
}
