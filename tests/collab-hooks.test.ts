import { afterAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CollabHooks } from '../src/collab/hooks';
import { EMPTY_DOC } from '../src/projects/empty-doc';
import { makeApp } from './helpers/app';
import { testPrisma } from './helpers/db';
import { createUser, sessionCookie } from './helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

it.each(['promote', 'demote', 'rename', 'delete', 'add', 'change', 'remove'])(
  '%s conserva el éxito de DB cuando falla el hook y registra el error',
  async (action) => {
    const failure = new Error('socket unavailable');
    const failedHook = vi.fn(async () => {
      throw failure;
    });
    const rooms: CollabHooks = {
      onUserRoleChanged: failedHook,
      onMembershipChanged: failedHook,
      onProjectRenamed: failedHook,
      onProjectDeleted: failedHook,
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, prisma } = await makeApp({ rooms });
      const admin = await createUser(prisma, 'admin@example.com', { isAdmin: true });
      const user = await createUser(prisma, 'user@example.com', { isAdmin: action === 'demote' });
      const cookie = await sessionCookie(prisma, admin.id);
      const project = await prisma.project.create({ data: { name: 'Antes', diagram: EMPTY_DOC } });
      const url = `/api/projects/${project.id}`;
      if (action === 'change' || action === 'remove') {
        await prisma.projectMember.create({
          data: { projectId: project.id, userId: user.id, role: 'editor' },
        });
      }
      if (action === 'promote' || action === 'demote') {
        const isAdmin = action === 'promote';
        const res = await request(app)
          .patch(`/api/admin/users/${user.id}`)
          .set('Cookie', cookie)
          .send({ isAdmin });
        expect(res.status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isAdmin).toBe(
          isAdmin,
        );
        expect(failedHook).toHaveBeenCalledWith(user.id);
      } else if (action === 'rename') {
        const res = await request(app).patch(url).set('Cookie', cookie).send({ name: 'Después' });
        expect(res.status).toBe(200);
        expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe(
          'Después',
        );
        expect(failedHook).toHaveBeenCalledWith(project.id, 'Después');
      } else if (action === 'delete') {
        expect((await request(app).delete(url).set('Cookie', cookie)).status).toBe(204);
        expect(await prisma.project.count()).toBe(0);
        expect(failedHook).toHaveBeenCalledWith(project.id);
      } else {
        const res =
          action === 'add'
            ? await request(app)
                .post(`${url}/members`)
                .set('Cookie', cookie)
                .send({ email: user.email, role: 'viewer' })
            : action === 'change'
              ? await request(app)
                  .patch(`${url}/members/${user.id}`)
                  .set('Cookie', cookie)
                  .send({ role: 'viewer' })
              : await request(app).delete(`${url}/members/${user.id}`).set('Cookie', cookie);
        expect(res.status).toBe(action === 'remove' ? 204 : 200);
        const member = await prisma.projectMember.findFirst();
        if (action === 'remove') expect(member).toBeNull();
        else expect(member?.role).toBe('viewer');
        expect(failedHook).toHaveBeenCalledWith(project.id, user.id);
      }
      expect(logged).toHaveBeenCalledWith('Collaboration hook failed:', failure);
    } finally {
      logged.mockRestore();
    }
  },
);
