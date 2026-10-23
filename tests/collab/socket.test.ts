import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager, type RoomManagerOptions } from '../../src/collab/rooms';
import { MemoryMailer } from '../../src/mail/mailer';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { createServer } from '../../src/server';
import { TEST_CONFIG } from '../helpers/app';
import { BackgroundTasks } from '../helpers/background';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser, PASSWORD } from '../helpers/users';

const prisma = testPrisma();

type TestHarness = {
  baseUrl: string;
  rooms: RoomManager;
  app: ReturnType<typeof createServer>['http'];
  connect: (cookie?: string, origin?: string) => ClientSocket;
  loginCookie: (email: string, password?: string) => Promise<string>;
  close: () => Promise<void>;
};

let activeHarness: TestHarness | null = null;

async function startHarness(roomOpts: RoomManagerOptions = {}): Promise<TestHarness> {
  const mailer = new MemoryMailer();
  const background = new BackgroundTasks();
  const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000, ...roomOpts });
  const { http, io } = createServer({
    prisma,
    mailer,
    config: TEST_CONFIG,
    runInBackground: background.run,
    rooms,
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: ClientSocket[] = [];

  const connect = (cookie?: string, origin = TEST_CONFIG.appUrl) => {
    const extraHeaders: Record<string, string> = {};
    if (cookie) extraHeaders.Cookie = cookie;
    if (origin) extraHeaders.Origin = origin;
    const client = createClient(baseUrl, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      extraHeaders,
    });
    sockets.push(client);
    return client;
  };

  const loginCookie = async (email: string, password = PASSWORD): Promise<string> => {
    const res = await request(http).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toBeTruthy();
    return raw.split(';')[0];
  };

  const close = async () => {
    for (const s of sockets) s.disconnect();
    await rooms.flushAll();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (http.listening) {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };

  const harness = { baseUrl, rooms, app: http, connect, loginCookie, close };
  activeHarness = harness;
  return harness;
}

function connectSocket(client: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      client.off('connect', onConnect);
      client.off('connect_error', onError);
    };
    client.on('connect', onConnect);
    client.on('connect_error', onError);
    client.connect();
  });
}

function joinRoom<T = Record<string, unknown>>(
  client: ClientSocket,
  projectId: string,
): Promise<T> {
  return new Promise((resolve) => {
    client.emit('join', { projectId }, (res: T) => resolve(res));
  });
}

function waitForEvent<T = unknown>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(event, (data: T) => resolve(data));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  if (activeHarness) {
    await activeHarness.close();
    activeHarness = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Socket.IO collaboration (registerCollab)', () => {
  it('sin cookie, la conexión se rechaza con unauthorized', async () => {
    const h = await startHarness();
    const client = h.connect();

    await expect(connectSocket(client)).rejects.toThrow('unauthorized');
  });

  it('un no miembro recibe join con not_found', async () => {
    const h = await startHarness();
    const outsider = await createUser(prisma, 'outsider@example.com');
    const project = await prisma.project.create({
      data: { name: 'Privado', diagram: EMPTY_DOC },
    });

    const cookie = await h.loginCookie(outsider.email);
    const client = h.connect(cookie);
    await connectSocket(client);

    const res = await joinRoom<{ ok: boolean; error?: string }>(client, project.id);
    expect(res).toEqual({ ok: false, error: 'not_found' });
  });

  it('el cliente A envía sadd del campo X y B envía sadd del campo Y en la misma tabla casi a la vez: ambos reciben la op del otro, version final base+2 y diagram tras flush contiene X e Y', async () => {
    const h = await startHarness();
    const userA = await createUser(prisma, 'a@example.com');
    const userB = await createUser(prisma, 'b@example.com');
    const baseDoc = {
      ...EMPTY_DOC,
      tables: [{ id: 't1', name: 'users', fields: [], indices: [], uniqueConstraints: [] }],
    };
    const project = await prisma.project.create({
      data: { name: 'Concurrente', diagram: baseDoc, version: 5n },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: userA.id, role: 'editor' },
        { projectId: project.id, userId: userB.id, role: 'editor' },
      ],
    });

    const [cookieA, cookieB] = await Promise.all([
      h.loginCookie(userA.email),
      h.loginCookie(userB.email),
    ]);
    const clientA = h.connect(cookieA);
    const clientB = h.connect(cookieB);
    await Promise.all([connectSocket(clientA), connectSocket(clientB)]);

    const joinA = await joinRoom<{ ok: boolean; version: number }>(clientA, project.id);
    const joinB = await joinRoom<{ ok: boolean; version: number }>(clientB, project.id);
    expect(joinA.ok).toBe(true);
    expect(joinA.version).toBe(5);
    expect(joinB.ok).toBe(true);
    expect(joinB.version).toBe(5);

    const opX = {
      t: 'sadd' as const,
      coll: 'tables' as const,
      id: 't1',
      sub: 'fields' as const,
      item: { id: 'fX', name: 'X', type: 'INT' },
      index: 0,
    };
    const opY = {
      t: 'sadd' as const,
      coll: 'tables' as const,
      id: 't1',
      sub: 'fields' as const,
      item: { id: 'fY', name: 'Y', type: 'TEXT' },
      index: 1,
    };

    const ackAPromise = waitForEvent<{ seq: number; version: number; ok: boolean }>(clientA, 'ack');
    const ackBPromise = waitForEvent<{ seq: number; version: number; ok: boolean }>(clientB, 'ack');
    const remoteOnAPromise = waitForEvent<{ version: number; ops: unknown[]; by: string }>(
      clientA,
      'ops',
    );
    const remoteOnBPromise = waitForEvent<{ version: number; ops: unknown[]; by: string }>(
      clientB,
      'ops',
    );

    clientA.emit('ops', { seq: 1, ops: [opX] });
    clientB.emit('ops', { seq: 1, ops: [opY] });

    const [ackA, ackB, remoteOnA, remoteOnB] = await Promise.all([
      ackAPromise,
      ackBPromise,
      remoteOnAPromise,
      remoteOnBPromise,
    ]);

    expect(ackA.ok).toBe(true);
    expect(ackB.ok).toBe(true);
    expect([ackA.version, ackB.version].sort()).toEqual([6, 7]);
    expect(remoteOnA.ops).toEqual([opY]);
    expect(remoteOnA.by).toBe(userB.id);
    expect(remoteOnB.ops).toEqual([opX]);
    expect(remoteOnB.by).toBe(userA.id);

    await h.rooms.flush(project.id);
    const updated = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(updated.version)).toBe(7);
    const diagram = updated.diagram as { tables: { fields: { id: string; name: string }[] }[] };
    const fieldNames = diagram.tables[0].fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(['X', 'Y']);
  });

  it('un viewer recibe forbidden y el documento no cambia', async () => {
    const h = await startHarness();
    const viewer = await createUser(prisma, 'viewer@example.com');
    const project = await prisma.project.create({
      data: { name: 'SoloLectura', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: viewer.id, role: 'viewer' },
    });

    const cookie = await h.loginCookie(viewer.email);
    const client = h.connect(cookie);
    await connectSocket(client);

    const joined = await joinRoom<{ ok: boolean; role: string; version: number }>(
      client,
      project.id,
    );
    expect(joined.ok).toBe(true);
    expect(joined.role).toBe('viewer');

    const ackPromise = waitForEvent<{ seq: number; ok: boolean; error?: string }>(client, 'ack');
    client.emit('ops', {
      seq: 1,
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });
    const ack = await ackPromise;
    expect(ack).toEqual({ seq: 1, ok: false, error: 'forbidden' });

    await h.rooms.flush(project.id);
    const inDb = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(inDb.version)).toBe(0);
    expect(inDb.diagram).toEqual(EMPTY_DOC);
  });

  it('tras DELETE /api/projects/:id/members/:B, B recibe access_revoked y queda desconectado', async () => {
    const h = await startHarness();
    const admin = await createUser(prisma, 'admin@example.com', { isAdmin: true });
    const userB = await createUser(prisma, 'b@example.com');
    const project = await prisma.project.create({
      data: { name: 'Revocar', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: userB.id, role: 'editor' },
    });

    const [adminCookie, cookieB] = await Promise.all([
      h.loginCookie(admin.email),
      h.loginCookie(userB.email),
    ]);
    const clientB = h.connect(cookieB);
    await connectSocket(clientB);
    const joined = await joinRoom<{ ok: boolean }>(clientB, project.id);
    expect(joined.ok).toBe(true);

    const revokedPromise = waitForEvent(clientB, 'access_revoked');
    const disconnectPromise = waitForEvent(clientB, 'disconnect');

    const delRes = await request(h.app)
      .delete(`/api/projects/${project.id}/members/${userB.id}`)
      .set('Cookie', adminCookie);
    expect(delRes.status).toBe(204);

    await Promise.all([revokedPromise, disconnectPromise]);
    expect(clientB.connected).toBe(false);
  });

  it('con saveDebounceMs=50, la base de datos refleja los cambios sin necesidad de flush explícito', async () => {
    const h = await startHarness({ saveDebounceMs: 50 });
    const editor = await createUser(prisma, 'editor@example.com');
    const project = await prisma.project.create({
      data: { name: 'AutoSave', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);
    await joinRoom(client, project.id);

    const ackPromise = waitForEvent<{ ok: boolean; version: number }>(client, 'ack');
    client.emit('ops', {
      seq: 1,
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });
    expect(await ackPromise).toEqual({ seq: 1, version: 1, ok: true });

    await sleep(150);

    const saved = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(saved.version)).toBe(1);
    expect(saved.diagram).toMatchObject({ database: 'postgresql' });
  });

  it('con snapshotIntervalMs=0, tras 5 guardados quedan 5 snapshots', async () => {
    const h = await startHarness({
      saveDebounceMs: 60_000,
      snapshotIntervalMs: 0,
    });
    const editor = await createUser(prisma, 'snap@example.com');
    const project = await prisma.project.create({
      data: { name: 'SnapKeep', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);
    await joinRoom(client, project.id);

    for (let i = 1; i <= 5; i++) {
      const ackPromise = waitForEvent<{ ok: boolean; version: number }>(client, 'ack');
      client.emit('ops', {
        seq: i,
        ops: [{ t: 'add', coll: 'notes', item: { id: `n${i}`, title: `${i}` }, index: i - 1 }],
      });
      await ackPromise;
      await h.rooms.flush(project.id);
    }

    const snapshots = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'asc' },
    });
    expect(snapshots).toHaveLength(5);
    expect(snapshots.map((s) => Number(s.version))).toEqual([1, 2, 3, 4, 5]);
  });

  it('awareness llega al resto de la sala pero no de vuelta al emisor', async () => {
    const h = await startHarness();
    const userA = await createUser(prisma, 'a@example.com');
    const userB = await createUser(prisma, 'b@example.com');
    const project = await prisma.project.create({
      data: { name: 'Awareness', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: userA.id, role: 'editor' },
        { projectId: project.id, userId: userB.id, role: 'viewer' },
      ],
    });

    const [cookieA, cookieB] = await Promise.all([
      h.loginCookie(userA.email),
      h.loginCookie(userB.email),
    ]);
    const clientA = h.connect(cookieA);
    const clientB = h.connect(cookieB);
    await Promise.all([connectSocket(clientA), connectSocket(clientB)]);
    await joinRoom(clientA, project.id);
    await joinRoom(clientB, project.id);

    let echoedToA = false;
    clientA.on('awareness', () => {
      echoedToA = true;
    });

    const onB = waitForEvent<{
      userId: string;
      cursor: { x: number; y: number } | null;
      linking: null;
    }>(clientB, 'awareness');

    clientA.emit('awareness', { cursor: { x: 120, y: 240 }, linking: null });

    const received = await onB;
    expect(received).toEqual({
      userId: userA.id,
      cursor: { x: 120, y: 240 },
      linking: null,
    });

    await sleep(50);
    expect(echoedToA).toBe(false);
  });

  it('deduplica peers con múltiples pestañas y notifica cambios de rol, renombrado y borrado', async () => {
    const h = await startHarness();
    const superadmin = await createUser(prisma, 'root@example.com', {
      isAdmin: true,
      isSuperadmin: true,
    });
    const userA = await createUser(prisma, 'a@example.com', { isAdmin: true });
    const project = await prisma.project.create({
      data: { name: 'Inicial', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: userA.id, role: 'viewer' },
    });

    const [rootCookie, cookieA] = await Promise.all([
      h.loginCookie(superadmin.email),
      h.loginCookie(userA.email),
    ]);

    const tab1 = h.connect(cookieA);
    const tab2 = h.connect(cookieA);
    await Promise.all([connectSocket(tab1), connectSocket(tab2)]);

    const join1 = await joinRoom<{ ok: boolean; peers: { userId: string }[]; role: string }>(
      tab1,
      project.id,
    );
    const join2 = await joinRoom<{ ok: boolean; peers: { userId: string }[]; role: string }>(
      tab2,
      project.id,
    );
    expect(join1.role).toBe('admin');
    expect(join2.peers).toHaveLength(1);
    expect(join2.peers[0].userId).toBe(userA.id);

    // Demote userA from admin -> since userA is a member with role 'viewer', receives role_changed
    const roleChangedPromise = waitForEvent<{ role: string }>(tab1, 'role_changed');
    const demoteRes = await request(h.app)
      .patch(`/api/admin/users/${userA.id}`)
      .set('Cookie', rootCookie)
      .send({ isAdmin: false });
    expect(demoteRes.status).toBe(200);
    expect(await roleChangedPromise).toEqual({ role: 'viewer' });

    // Rename project -> receives renamed
    const renamedPromise = waitForEvent<{ name: string }>(tab1, 'renamed');
    const renameRes = await request(h.app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', rootCookie)
      .send({ name: 'Renombrado' });
    expect(renameRes.status).toBe(200);
    expect(await renamedPromise).toEqual({ name: 'Renombrado' });

    // Delete project -> receives deleted
    const deletedPromise = waitForEvent(tab1, 'deleted');
    const deleteRes = await request(h.app)
      .delete(`/api/projects/${project.id}`)
      .set('Cookie', rootCookie);
    expect(deleteRes.status).toBe(204);
    await deletedPromise;
  });

  it('si la sesión del editor se invalida en la base de datos tras join, el siguiente ops se rechaza con unauthorized, emite access_revoked, desconecta y no modifica el documento', async () => {
    const h = await startHarness();
    const editor = await createUser(prisma, 'editor-logout@example.com');
    const project = await prisma.project.create({
      data: { name: 'RevalidateDelta', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);
    const joinRes = await joinRoom<{ ok: boolean; version: number }>(client, project.id);
    expect(joinRes.ok).toBe(true);
    expect(joinRes.version).toBe(0);

    await prisma.session.deleteMany({ where: { userId: editor.id } });

    const ackPromise = waitForEvent<{ seq: number; ok: boolean; error?: string }>(client, 'ack');
    const revokedPromise = waitForEvent(client, 'access_revoked');
    const disconnectPromise = waitForEvent(client, 'disconnect');

    client.emit('ops', {
      seq: 1,
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });

    const [ack] = await Promise.all([ackPromise, revokedPromise, disconnectPromise]);
    expect(ack).toEqual({ seq: 1, ok: false, error: 'unauthorized' });
    expect(client.connected).toBe(false);

    await h.rooms.flushAll();
    const saved = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(saved.version)).toBe(0);
    expect(saved.diagram).toEqual(EMPTY_DOC);
  });

  it('cierra la ventana TOCTOU en join si se revoca la membresía o se borra el proyecto mientras join está en vuelo', async () => {
    const h = await startHarness();
    const editor = await createUser(prisma, 'toctou-editor@example.com');
    const project = await prisma.project.create({
      data: { name: 'ToctouProject', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);

    const origJoin = h.rooms.join.bind(h.rooms);
    h.rooms.join = async (pid: string) => {
      const res = await origJoin(pid);
      // Revoke membership while rooms.join is in flight before socket finishes joining
      await prisma.projectMember.deleteMany({
        where: { projectId: pid, userId: editor.id },
      });
      await h.rooms.onMembershipChanged(pid, editor.id);
      return res;
    };

    const joinRes = await joinRoom<{ ok: boolean; error?: string }>(client, project.id);
    expect(joinRes.ok).toBe(false);
    expect(joinRes.error).toBe('not_found');
  });

  it('desconecta inmediatamente los sockets pasivos cuando el usuario hace POST /api/auth/logout', async () => {
    const h = await startHarness();
    const user = await createUser(prisma, 'passive-logout@example.com');
    const project = await prisma.project.create({
      data: { name: 'PassiveLogout', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(user.email);
    const client = h.connect(cookie);
    await connectSocket(client);
    const joinRes = await joinRoom<{ ok: boolean }>(client, project.id);
    expect(joinRes.ok).toBe(true);

    const revokedPromise = waitForEvent(client, 'access_revoked');
    const disconnectPromise = waitForEvent(client, 'disconnect');

    const logoutRes = await request(h.app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(204);

    await Promise.race([
      Promise.all([revokedPromise, disconnectPromise]),
      sleep(500).then(() => {
        throw new Error('Timed out waiting for passive socket revocation');
      }),
    ]);
    expect(client.connected).toBe(false);
  });

  it('join devuelve el epoch de la sala', async () => {
    const h = await startHarness();
    const editor = await createUser(prisma, 'epoch-join@example.com');
    const project = await prisma.project.create({
      data: { name: 'EpochJoin', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);

    const reply = await joinRoom<{ ok: boolean; epoch: number }>(client, project.id);
    expect(reply.ok).toBe(true);
    expect(reply.epoch).toBe(0);
  });

  it('un lote con epoch obsoleto recibe stale_epoch y no se retransmite', async () => {
    const h = await startHarness();
    const userA = await createUser(prisma, 'stale-a@example.com');
    const userB = await createUser(prisma, 'stale-b@example.com');
    const project = await prisma.project.create({
      data: { name: 'StaleEpoch', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: userA.id, role: 'editor' },
        { projectId: project.id, userId: userB.id, role: 'editor' },
      ],
    });

    const [cookieA, cookieB] = await Promise.all([
      h.loginCookie(userA.email),
      h.loginCookie(userB.email),
    ]);
    const clientA = h.connect(cookieA);
    const clientB = h.connect(cookieB);
    await Promise.all([connectSocket(clientA), connectSocket(clientB)]);
    await joinRoom(clientA, project.id);
    await joinRoom(clientB, project.id);

    let receivedOpsOnB = false;
    clientB.on('ops', () => {
      receivedOpsOnB = true;
    });

    const ackPromise = waitForEvent<{ seq: number; ok: boolean; error?: string }>(clientA, 'ack');
    clientA.emit('ops', {
      seq: 1,
      epoch: 99,
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });

    const ack = await ackPromise;
    expect(ack).toEqual({ seq: 1, ok: false, error: 'stale_epoch' });

    await sleep(200);
    expect(receivedOpsOnB).toBe(false);

    const invalidEpochAckPromise = waitForEvent<{ seq: number; ok: boolean; error?: string }>(
      clientA,
      'ack',
    );
    clientA.emit('ops', {
      seq: 2,
      epoch: 'invalid',
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });
    expect(await invalidEpochAckPromise).toEqual({ seq: 2, ok: false, error: 'invalid_ops' });
  });

  it('un lote sin epoch se sigue aceptando', async () => {
    const h = await startHarness();
    const editor = await createUser(prisma, 'no-epoch@example.com');
    const project = await prisma.project.create({
      data: { name: 'NoEpoch', diagram: EMPTY_DOC },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const cookie = await h.loginCookie(editor.email);
    const client = h.connect(cookie);
    await connectSocket(client);
    await joinRoom(client, project.id);

    const ackPromise = waitForEvent<{ seq: number; ok: boolean; version: number }>(client, 'ack');
    client.emit('ops', {
      seq: 1,
      ops: [{ t: 'set', key: 'database', value: 'postgresql' }],
    });

    const ack = await ackPromise;
    expect(ack).toEqual({ seq: 1, version: 1, ok: true });

    await h.rooms.flush(project.id);
    const snap = await prisma.projectSnapshot.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(snap.authors).toEqual([{ id: editor.id, name: editor.name }]);
  });

  // TODO(Task 6 - Review Focus 1): 'tras restaurar, un lote en vuelo con el epoch anterior se rechaza y el documento queda como el restaurado'
});
