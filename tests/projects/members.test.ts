import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CollabHooks } from '../../src/collab/hooks';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN, makeApp, type MakeAppOptions } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { createUser, PASSWORD, sessionCookie, tokenFromMail } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const NEW_EMAIL = `eva@${ALLOWED_DOMAIN}`;
const DAY = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/** An app with an admin (with session cookie) and one project. */
async function setup(opts: MakeAppOptions = {}) {
  const ctx = await makeApp(opts);
  const admin = await createUser(ctx.prisma, `jefa@${ALLOWED_DOMAIN}`, { isAdmin: true });
  const project = await ctx.prisma.project.create({ data: { name: 'Ventas', diagram: EMPTY_DOC } });
  const adminCookie = await sessionCookie(ctx.prisma, admin.id);
  const members = `/api/projects/${project.id}/members`;
  const addMember = (email: string, role = 'editor') =>
    request(ctx.app).post(members).set('Cookie', adminCookie).send({ email, role });
  return { ...ctx, admin, project, adminCookie, members, addMember };
}

function fakeRooms(): CollabHooks {
  return { onMembershipChanged: vi.fn(), onProjectRenamed: vi.fn(), onProjectDeleted: vi.fn() };
}

describe('POST /api/projects/:id/members', () => {
  it('invitar a un correo de dominio no permitido da 400 y no envía nada', async () => {
    const { addMember, prisma, mailer, settle } = await setup();
    const res = await addMember('eva@otro.com');
    await settle();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'registration_not_allowed' });
    expect(await prisma.projectInvitation.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('invita a un correo nuevo; al registrarse y verificar ve el proyecto con el rol invitado', async () => {
    const { app, addMember, project, prisma, mailer, settle } = await setup();
    const res = await addMember(` Eva@${ALLOWED_DOMAIN.toUpperCase()} `, 'viewer');
    await settle();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'invited' });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(NEW_EMAIL);
    expect(mailer.sent[0].subject).toContain('Ventas');
    expect(mailer.sent[0].text).toContain(
      `http://localhost:5173/register?email=${encodeURIComponent(NEW_EMAIL)}`,
    );
    const invitation = await prisma.projectInvitation.findFirstOrThrow();
    expect(invitation).toMatchObject({ email: NEW_EMAIL, role: 'viewer', acceptedAt: null });
    expect(invitation.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = invitation.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * DAY - 60_000);
    expect(ttl).toBeLessThanOrEqual(14 * DAY);

    await request(app)
      .post('/api/auth/register')
      .send({ email: NEW_EMAIL, name: 'Eva', password: PASSWORD });
    await settle();
    const token = tokenFromMail(mailer.sent[1].text, '/verify');
    const verified = await request(app)
      .post('/api/auth/verify')
      .send({ token, password: PASSWORD });
    expect(verified.status).toBe(200);

    const list = await request(app)
      .get('/api/projects')
      .set('Cookie', String(verified.headers['set-cookie']));
    expect(list.body).toEqual([
      { id: project.id, name: 'Ventas', role: 'viewer', updatedAt: expect.any(String) },
    ]);
  });

  it('una invitación caducada no se convierte en membresía', async () => {
    const { app, addMember, prisma, mailer, settle } = await setup();
    await addMember(NEW_EMAIL);
    await prisma.projectInvitation.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app)
      .post('/api/auth/register')
      .send({ email: NEW_EMAIL, name: 'Eva', password: PASSWORD });
    await settle();
    const token = tokenFromMail(mailer.sent[1].text, '/verify');
    const verified = await request(app)
      .post('/api/auth/verify')
      .send({ token, password: PASSWORD });
    expect(verified.status).toBe(200);
    expect(await prisma.projectMember.count()).toBe(0);
    const list = await request(app)
      .get('/api/projects')
      .set('Cookie', String(verified.headers['set-cookie']));
    expect(list.body).toEqual([]);
  });

  it('reinvitar el mismo correo renueva la invitación en vez de duplicarla', async () => {
    const { addMember, prisma, settle } = await setup();
    await addMember(NEW_EMAIL, 'editor');
    await prisma.projectInvitation.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const first = await prisma.projectInvitation.findFirstOrThrow();

    const res = await addMember(NEW_EMAIL, 'viewer');
    await settle();
    expect(res.body).toEqual({ status: 'invited' });
    const invitations = await prisma.projectInvitation.findMany();
    expect(invitations).toHaveLength(1);
    expect(invitations[0].id).toBe(first.id);
    expect(invitations[0].role).toBe('viewer');
    expect(invitations[0].tokenHash).not.toBe(first.tokenHash);
    expect(invitations[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('añade directamente a un usuario verificado, aunque su dominio no esté permitido', async () => {
    const rooms = fakeRooms();
    const { addMember, project, prisma, mailer, settle } = await setup({ rooms });
    const user = await createUser(prisma, 'externa@otro.com');
    const res = await addMember('externa@otro.com', 'viewer');
    await settle();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'added' });
    expect(await prisma.projectMember.findMany()).toEqual([
      { projectId: project.id, userId: user.id, role: 'viewer' },
    ]);
    expect(await prisma.projectInvitation.count()).toBe(0);
    expect(rooms.onMembershipChanged).toHaveBeenCalledWith(project.id, user.id);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe('Te añadieron al proyecto "Ventas" — drawDB');
    expect(mailer.sent[0].text).toContain(`http://localhost:5173/projects/${project.id}`);

    await addMember('externa@otro.com', 'editor');
    const member = await prisma.projectMember.findFirstOrThrow();
    expect(member.role).toBe('editor');
  });

  it('a un usuario sin verificar lo invita, para que el acceso llegue al verificar', async () => {
    const { addMember, prisma, settle } = await setup();
    await createUser(prisma, NEW_EMAIL, { verified: false });
    const res = await addMember(NEW_EMAIL);
    await settle();
    expect(res.body).toEqual({ status: 'invited' });
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.projectInvitation.count()).toBe(1);
  });

  it('rechaza entradas inválidas y proyectos inexistentes', async () => {
    const { app, adminCookie, addMember } = await setup();
    const badRole = await addMember(NEW_EMAIL, 'owner');
    expect(badRole.status).toBe(400);
    expect(badRole.body).toEqual({ error: 'invalid_input' });
    const missing = await request(app)
      .post(`/api/projects/${UNKNOWN_ID}/members`)
      .set('Cookie', adminCookie)
      .send({ email: NEW_EMAIL, role: 'editor' });
    expect(missing.status).toBe(404);
  });
});

describe('miembros e invitaciones de un proyecto', () => {
  it('lista miembros e invitaciones pendientes, cambia roles y quita', async () => {
    const rooms = fakeRooms();
    const { app, adminCookie, members, addMember, project, prisma, settle } = await setup({
      rooms,
    });
    const user = await createUser(prisma, `ana@${ALLOWED_DOMAIN}`);
    await addMember(user.email, 'editor');
    await addMember(NEW_EMAIL, 'viewer');
    await settle();

    const list = await request(app).get(members).set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const invitation = await prisma.projectInvitation.findFirstOrThrow();
    expect(list.body).toEqual({
      members: [{ userId: user.id, email: user.email, name: 'Usuaria', role: 'editor' }],
      invitations: [
        {
          id: invitation.id,
          email: NEW_EMAIL,
          role: 'viewer',
          expiresAt: invitation.expiresAt.toISOString(),
        },
      ],
    });

    const changed = await request(app)
      .patch(`${members}/${user.id}`)
      .set('Cookie', adminCookie)
      .send({ role: 'viewer' });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ userId: user.id, role: 'viewer' });
    expect((await prisma.projectMember.findFirstOrThrow()).role).toBe('viewer');

    const removed = await request(app).delete(`${members}/${user.id}`).set('Cookie', adminCookie);
    expect(removed.status).toBe(204);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(rooms.onMembershipChanged).toHaveBeenCalledTimes(3);
    expect(rooms.onMembershipChanged).toHaveBeenLastCalledWith(project.id, user.id);

    const cancelled = await request(app)
      .delete(`/api/projects/${project.id}/invitations/${invitation.id}`)
      .set('Cookie', adminCookie);
    expect(cancelled.status).toBe(204);
    expect(await prisma.projectInvitation.count()).toBe(0);
  });

  it('da 404 al tocar un miembro o invitación que no existe', async () => {
    const { app, adminCookie, members, project } = await setup();
    const responses = await Promise.all([
      request(app)
        .patch(`${members}/${UNKNOWN_ID}`)
        .set('Cookie', adminCookie)
        .send({ role: 'viewer' }),
      request(app).delete(`${members}/${UNKNOWN_ID}`).set('Cookie', adminCookie),
      request(app)
        .delete(`/api/projects/${project.id}/invitations/${UNKNOWN_ID}`)
        .set('Cookie', adminCookie),
      request(app).get(`/api/projects/${UNKNOWN_ID}/members`).set('Cookie', adminCookie),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('un usuario normal no gestiona miembros, aunque sea miembro', async () => {
    const { app, members, project, prisma } = await setup();
    const user = await createUser(prisma, `ana@${ALLOWED_DOMAIN}`);
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: 'editor' },
    });
    const cookie = await sessionCookie(prisma, user.id);
    const list = await request(app).get(members).set('Cookie', cookie);
    expect(list.status).toBe(403);
    const add = await request(app)
      .post(members)
      .set('Cookie', cookie)
      .send({ email: NEW_EMAIL, role: 'editor' });
    expect(add.status).toBe(403);
  });
});
