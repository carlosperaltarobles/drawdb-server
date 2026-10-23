import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RoomManager } from '../../src/collab/rooms';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, sessionCookie } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

async function setup() {
  const prisma = testPrisma();
  const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
  const ctx = await makeApp({ rooms, history: rooms });

  const admin = await createUser(prisma, `admin@${ALLOWED_DOMAIN}`, { isAdmin: true });
  const editor = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
  const viewer = await createUser(prisma, `viewer@${ALLOWED_DOMAIN}`);
  const outsider = await createUser(prisma, `outsider@${ALLOWED_DOMAIN}`);

  const project = await prisma.project.create({
    data: { name: 'Proyecto', diagram: EMPTY_DOC, createdBy: admin.id },
  });

  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: editor.id, role: 'editor' },
      { projectId: project.id, userId: viewer.id, role: 'viewer' },
    ],
  });

  const [adminCookie, editorCookie, viewerCookie, outsiderCookie] = await Promise.all([
    sessionCookie(prisma, admin.id),
    sessionCookie(prisma, editor.id),
    sessionCookie(prisma, viewer.id),
    sessionCookie(prisma, outsider.id),
  ]);

  return {
    ...ctx,
    rooms,
    project,
    admin,
    editor,
    viewer,
    outsider,
    adminCookie,
    editorCookie,
    viewerCookie,
    outsiderCookie,
  };
}

describe('/api/projects/:id/history', () => {
  it('lista sin diagram, paginada y en orden descendente', async () => {
    const { app, prisma, project, editor, viewerCookie } = await setup();

    const s1 = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 1n,
        kind: 'auto',
        authors: [{ id: editor.id, name: editor.name }],
        sizeBytes: 120,
        createdAt: new Date('2026-06-15T10:00:00.000Z'),
      },
    });
    const s2 = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 2n,
        kind: 'named',
        name: 'V1',
        createdBy: editor.id,
        authors: [],
        sizeBytes: 130,
        createdAt: new Date('2026-06-15T11:00:00.000Z'),
      },
    });
    const s3 = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 3n,
        kind: 'auto',
        authors: [{ id: editor.id, name: editor.name }],
        sizeBytes: 140,
        createdAt: new Date('2026-06-15T12:00:00.000Z'),
      },
    });

    const page1 = await request(app)
      .get(`/api/projects/${project.id}/history?limit=2`)
      .set('Cookie', viewerCookie);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([s3.id, s2.id]);
    for (const item of page1.body.items) {
      expect(item).not.toHaveProperty('diagram');
      expect(Array.isArray(item.authors)).toBe(true);
    }
    expect(page1.body.items[0].authors).toEqual([{ id: editor.id, name: editor.name }]);
    expect(page1.body.items[1].createdBy).toEqual({ id: editor.id, name: editor.name });
    expect(page1.body.nextCursor).toBe(s2.id);

    const page2 = await request(app)
      .get(`/api/projects/${project.id}/history?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Cookie', viewerCookie);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).toBe(s1.id);
    expect(page2.body.items[0]).not.toHaveProperty('diagram');
    expect(page2.body.nextCursor).toBeNull();
  });

  it('un no miembro recibe 404 en todas las rutas', async () => {
    const { app, prisma, project, outsiderCookie } = await setup();
    const snap = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 1n,
        kind: 'named',
        name: 'V1',
      },
    });

    const base = `/api/projects/${project.id}/history`;
    const responses = await Promise.all([
      request(app).get(base).set('Cookie', outsiderCookie),
      request(app).get(`${base}/${snap.id}`).set('Cookie', outsiderCookie),
      request(app).post(base).set('Cookie', outsiderCookie).send({ name: 'Nueva' }),
      request(app)
        .patch(`${base}/${snap.id}`)
        .set('Cookie', outsiderCookie)
        .send({ name: 'Renombrada' }),
      request(app).delete(`${base}/${snap.id}`).set('Cookie', outsiderCookie),
      request(app).post(`${base}/${snap.id}/restore`).set('Cookie', outsiderCookie),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('un viewer lista y ve, pero recibe 403 al crear, renombrar, borrar y restaurar', async () => {
    const { app, prisma, project, viewerCookie } = await setup();
    const docWithNote = {
      ...EMPTY_DOC,
      notes: [{ id: 1, title: 'Nota', content: 'Hola' }],
    };
    const snap = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: docWithNote,
        version: 1n,
        kind: 'named',
        name: 'Inicial',
      },
    });

    const base = `/api/projects/${project.id}/history`;
    const listRes = await request(app).get(base).set('Cookie', viewerCookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);

    const getRes = await request(app).get(`${base}/${snap.id}`).set('Cookie', viewerCookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(snap.id);
    expect(getRes.body.diagram).toEqual(docWithNote);
    expect(Array.isArray(getRes.body.authors)).toBe(true);

    const writeResponses = await Promise.all([
      request(app).post(base).set('Cookie', viewerCookie).send({ name: 'Nueva' }),
      request(app)
        .patch(`${base}/${snap.id}`)
        .set('Cookie', viewerCookie)
        .send({ name: 'Renombrada' }),
      request(app).delete(`${base}/${snap.id}`).set('Cookie', viewerCookie),
      request(app).post(`${base}/${snap.id}/restore`).set('Cookie', viewerCookie),
    ]);

    for (const res of writeResponses) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
  });

  it('una copia de otro proyecto responde 404 en ver, renombrar, borrar y restaurar', async () => {
    const { app, prisma, project, adminCookie } = await setup();
    const otherProject = await prisma.project.create({
      data: { name: 'Otro', diagram: EMPTY_DOC },
    });
    const otherSnap = await prisma.projectSnapshot.create({
      data: {
        projectId: otherProject.id,
        diagram: EMPTY_DOC,
        version: 1n,
        kind: 'named',
        name: 'De otro proyecto',
      },
    });

    const base = `/api/projects/${project.id}/history/${otherSnap.id}`;
    const responses = await Promise.all([
      request(app).get(base).set('Cookie', adminCookie),
      request(app).patch(base).set('Cookie', adminCookie).send({ name: 'Cambiado' }),
      request(app).delete(base).set('Cookie', adminCookie),
      request(app).post(`${base}/restore`).set('Cookie', adminCookie),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }

    const untouched = await prisma.projectSnapshot.findUnique({ where: { id: otherSnap.id } });
    expect(untouched?.name).toBe('De otro proyecto');
  });

  it('crear una versión con nombre usa el documento vigente', async () => {
    const { app, rooms, project, editor, editorCookie } = await setup();
    await rooms.join(project.id);
    rooms.apply(
      project.id,
      [{ t: 'add', coll: 'tables', index: 0, item: { id: 't1', name: 'usuarios', fields: [] } }],
      { author: { id: editor.id, name: editor.name } },
    );

    const createRes = await request(app)
      .post(`/api/projects/${project.id}/history`)
      .set('Cookie', editorCookie)
      .send({ name: '  Antes de v2  ' });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toEqual({
      id: expect.any(String),
      kind: 'named',
      name: 'Antes de v2',
      createdAt: expect.any(String),
      createdBy: { id: editor.id, name: editor.name },
      authors: [],
      sizeBytes: expect.any(Number),
    });

    const detailRes = await request(app)
      .get(`/api/projects/${project.id}/history/${createRes.body.id}`)
      .set('Cookie', editorCookie);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.diagram.tables).toEqual([{ id: 't1', name: 'usuarios', fields: [] }]);

    const tooLong = await request(app)
      .post(`/api/projects/${project.id}/history`)
      .set('Cookie', editorCookie)
      .send({ name: 'a'.repeat(81) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: 'invalid_input' });
  });

  it('con 100 versiones con nombre, crear otra responde 409 snapshot_limit', async () => {
    const { app, prisma, project, editorCookie } = await setup();
    await prisma.projectSnapshot.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: BigInt(i + 1),
        kind: 'named' as const,
        name: `Versión ${i + 1}`,
      })),
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/history`)
      .set('Cookie', editorCookie)
      .send({ name: 'Versión 101' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'snapshot_limit' });
  });

  it('renombrar o borrar una copia automática responde 404', async () => {
    const { app, prisma, project, editorCookie } = await setup();
    const autoSnap = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 1n,
        kind: 'auto',
      },
    });
    const namedSnap = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: EMPTY_DOC,
        version: 2n,
        kind: 'named',
        name: 'Original',
      },
    });

    const patchAuto = await request(app)
      .patch(`/api/projects/${project.id}/history/${autoSnap.id}`)
      .set('Cookie', editorCookie)
      .send({ name: 'Nuevo' });
    expect(patchAuto.status).toBe(404);

    const deleteAuto = await request(app)
      .delete(`/api/projects/${project.id}/history/${autoSnap.id}`)
      .set('Cookie', editorCookie);
    expect(deleteAuto.status).toBe(404);

    const patchNamed = await request(app)
      .patch(`/api/projects/${project.id}/history/${namedSnap.id}`)
      .set('Cookie', editorCookie)
      .send({ name: '  Renombrada  ' });
    expect(patchNamed.status).toBe(200);
    expect(patchNamed.body.name).toBe('Renombrada');

    const deleteNamed = await request(app)
      .delete(`/api/projects/${project.id}/history/${namedSnap.id}`)
      .set('Cookie', editorCookie);
    expect(deleteNamed.status).toBe(204);
    expect(await prisma.projectSnapshot.findUnique({ where: { id: namedSnap.id } })).toBeNull();
  });

  it('restaurar devuelve version y epoch y deja el proyecto restaurado', async () => {
    const { app, prisma, rooms, project, editorCookie } = await setup();
    const snapshotDiagram = {
      ...EMPTY_DOC,
      tables: [{ id: 't_restored', name: 'pedidos', fields: [] }],
    };
    const snap = await prisma.projectSnapshot.create({
      data: {
        projectId: project.id,
        diagram: snapshotDiagram,
        version: 1n,
        kind: 'auto',
      },
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/history/${snap.id}/restore`)
      .set('Cookie', editorCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 1, epoch: 1 });

    const peeked = await rooms.peekDoc(project.id);
    expect(peeked.doc).toEqual(snapshotDiagram);

    const updatedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updatedProject.diagram).toEqual(snapshotDiagram);

    const preRestore = await prisma.projectSnapshot.findFirst({
      where: { projectId: project.id, kind: 'pre_restore' },
    });
    expect(preRestore).not.toBeNull();
  });
});
