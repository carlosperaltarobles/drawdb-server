import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CollabHooks } from '../../src/collab/hooks';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN, makeApp, type MakeAppOptions } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, sessionCookie } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/** An app with an admin and a regular user, each with a session cookie. */
async function setup(opts: MakeAppOptions = {}) {
  const ctx = await makeApp(opts);
  const admin = await createUser(ctx.prisma, `jefa@${ALLOWED_DOMAIN}`, { isAdmin: true });
  const user = await createUser(ctx.prisma, `ana@${ALLOWED_DOMAIN}`);
  return {
    ...ctx,
    admin,
    user,
    adminCookie: await sessionCookie(ctx.prisma, admin.id),
    userCookie: await sessionCookie(ctx.prisma, user.id),
  };
}

function fakeRooms(): CollabHooks {
  return { onMembershipChanged: vi.fn(), onProjectRenamed: vi.fn(), onProjectDeleted: vi.fn() };
}

describe('/api/projects', () => {
  it('pide sesión', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  it('un usuario normal sin proyectos ve una lista vacía', async () => {
    const { app, adminCookie, userCookie } = await setup();
    await request(app).post('/api/projects').set('Cookie', adminCookie).send({ name: 'Ajeno' });
    const res = await request(app).get('/api/projects').set('Cookie', userCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('un administrador crea un proyecto vacío y lo ve con rol admin', async () => {
    const { app, prisma, admin, adminCookie } = await setup();
    const created = await request(app)
      .post('/api/projects')
      .set('Cookie', adminCookie)
      .send({ name: '  Ventas  ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: 'Ventas' });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(project.diagram).toEqual(EMPTY_DOC);
    expect(project.createdBy).toBe(admin.id);

    const list = await request(app).get('/api/projects').set('Cookie', adminCookie);
    expect(list.body).toEqual([
      { id: created.body.id, name: 'Ventas', role: 'admin', updatedAt: expect.any(String) },
    ]);
    const one = await request(app)
      .get(`/api/projects/${created.body.id}`)
      .set('Cookie', adminCookie);
    expect(one.body).toEqual({ id: created.body.id, name: 'Ventas', role: 'admin' });
  });

  it('un miembro ve solo sus proyectos, con su rol', async () => {
    const { app, prisma, user, userCookie } = await setup();
    const [mine] = await Promise.all(
      ['Mío', 'Ajeno'].map((name) => prisma.project.create({ data: { name, diagram: EMPTY_DOC } })),
    );
    await prisma.projectMember.create({
      data: { projectId: mine.id, userId: user.id, role: 'viewer' },
    });
    const list = await request(app).get('/api/projects').set('Cookie', userCookie);
    expect(list.body).toEqual([
      { id: mine.id, name: 'Mío', role: 'viewer', updatedAt: expect.any(String) },
    ]);
    const one = await request(app).get(`/api/projects/${mine.id}`).set('Cookie', userCookie);
    expect(one.body).toEqual({ id: mine.id, name: 'Mío', role: 'viewer' });
  });

  it('un usuario normal recibe 403 al crear, renombrar o borrar', async () => {
    const { app, prisma, userCookie } = await setup();
    const project = await prisma.project.create({ data: { name: 'P', diagram: EMPTY_DOC } });
    const responses = await Promise.all([
      request(app).post('/api/projects').set('Cookie', userCookie).send({ name: 'X' }),
      request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Cookie', userCookie)
        .send({ name: 'X' }),
      request(app).delete(`/api/projects/${project.id}`).set('Cookie', userCookie),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
    expect(await prisma.project.count()).toBe(1);
  });

  it('un no miembro recibe 404 en GET /:id, igual que con un proyecto inexistente', async () => {
    const { app, prisma, userCookie } = await setup();
    const project = await prisma.project.create({ data: { name: 'P', diagram: EMPTY_DOC } });
    for (const id of [project.id, UNKNOWN_ID]) {
      const res = await request(app).get(`/api/projects/${id}`).set('Cookie', userCookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('rechaza ids y nombres inválidos', async () => {
    const { app, adminCookie } = await setup();
    const badId = await request(app).get('/api/projects/no-es-uuid').set('Cookie', adminCookie);
    expect(badId.status).toBe(400);
    expect(badId.body).toEqual({ error: 'invalid_input' });
    const badName = await request(app)
      .post('/api/projects')
      .set('Cookie', adminCookie)
      .send({ name: '   ' });
    expect(badName.status).toBe(400);
    expect(badName.body).toEqual({ error: 'invalid_input' });
  });

  it('renombra y avisa a la sala', async () => {
    const rooms = fakeRooms();
    const { app, prisma, adminCookie } = await setup({ rooms });
    const project = await prisma.project.create({ data: { name: 'Viejo', diagram: EMPTY_DOC } });
    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Nuevo' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: project.id, name: 'Nuevo' });
    expect(rooms.onProjectRenamed).toHaveBeenCalledWith(project.id, 'Nuevo');

    const missing = await request(app)
      .patch(`/api/projects/${UNKNOWN_ID}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Nuevo' });
    expect(missing.status).toBe(404);
  });

  it('DELETE borra en cascada miembros, invitaciones y snapshots y avisa a la sala', async () => {
    const rooms = fakeRooms();
    const { app, prisma, user, adminCookie } = await setup({ rooms });
    const project = await prisma.project.create({ data: { name: 'P', diagram: EMPTY_DOC } });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: 'editor' },
    });
    await prisma.projectInvitation.create({
      data: {
        projectId: project.id,
        email: `eva@${ALLOWED_DOMAIN}`,
        role: 'viewer',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 1000),
      },
    });
    await prisma.projectSnapshot.create({
      data: { projectId: project.id, diagram: EMPTY_DOC, version: 1n },
    });

    const res = await request(app).delete(`/api/projects/${project.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(204);
    expect(rooms.onProjectDeleted).toHaveBeenCalledWith(project.id);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.projectInvitation.count()).toBe(0);
    expect(await prisma.projectSnapshot.count()).toBe(0);

    const again = await request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Cookie', adminCookie);
    expect(again.status).toBe(404);
  });
});
