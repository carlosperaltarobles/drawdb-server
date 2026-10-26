import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashDocument } from '../../src/ai/document-index';
import { prepareProposal } from '../../src/ai/proposal-validation';
import { AiRepository } from '../../src/ai/repository';
import { RoomManager } from '../../src/collab/rooms';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN } from '../helpers/app';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createPendingProposal(params: {
  repo: AiRepository;
  projectId: string;
  userId: string;
  conversationId: string;
  baseDoc: typeof EMPTY_DOC;
  baseVersion: number;
  noteId: string;
  noteTitle: string;
  expiresAt?: Date;
}) {
  const baseHash = hashDocument(params.baseDoc);
  const prepared = prepareProposal(
    params.baseDoc,
    {
      ops: [
        {
          t: 'add',
          coll: 'notes',
          index: 0,
          item: { id: params.noteId, title: params.noteTitle, content: 'AI Note' },
        },
      ],
    },
    { entities: null },
  );
  return params.repo.saveProposal({
    conversationId: params.conversationId,
    projectId: params.projectId,
    userId: params.userId,
    requestedModel: 'chat-a',
    reportedModel: 'chat-a',
    baseDoc: params.baseDoc,
    afterDoc: prepared.after as typeof EMPTY_DOC,
    ops: prepared.ops,
    baseVersion: params.baseVersion,
    baseHash,
    summary: prepared.summary,
    warnings: [],
    expiresAt: params.expiresAt ?? new Date(Date.now() + 3600_000),
  });
}

describe('Atomic AI proposal confirmation and collaboration serialization', () => {
  it('applies proposal atomically, creates pre_ai_apply snapshot, is idempotent across concurrent/repeated calls even after snapshot deletion, and serializes with manual apply and restore', async () => {
    const editor = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Atomic Apply Project', diagram: EMPTY_DOC, createdBy: editor.id },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const repo = new AiRepository(prisma);
    const conv = await repo.createConversation({
      projectId: project.id,
      userId: editor.id,
      selectedModel: 'chat-a',
    });

    const prop1 = await createPendingProposal({
      repo,
      projectId: project.id,
      userId: editor.id,
      conversationId: conv.id,
      baseDoc: EMPTY_DOC,
      baseVersion: 0,
      noteId: 'n_ai_1',
      noteTitle: 'First AI Note',
    });

    const [resA, resB] = await Promise.all([
      rooms.commitProposal({
        projectId: project.id,
        proposalId: prop1.id,
        revision: prop1.revision,
        user: editor,
      }),
      rooms.commitProposal({
        projectId: project.id,
        proposalId: prop1.id,
        revision: prop1.revision,
        user: editor,
      }),
    ]);

    expect(resA).toEqual(resB);
    expect(resA.applied).toBe(true);
    expect(resA.version).toBe(1);
    expect(resA.snapshotId).toBeTruthy();

    const safetySnaps = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id, kind: 'pre_ai_apply' },
    });
    expect(safetySnaps).toHaveLength(1);
    expect(safetySnaps[0]!.id).toBe(resA.snapshotId);

    await prisma.projectSnapshot.delete({ where: { id: resA.snapshotId! } });
    const resAfterSnapDeleted = await rooms.commitProposal({
      projectId: project.id,
      proposalId: prop1.id,
      revision: prop1.revision,
      user: editor,
    });
    expect(resAfterSnapDeleted).toEqual(resA);

    const joinedAfter1 = await rooms.join(project.id);
    const prop2 = await createPendingProposal({
      repo,
      projectId: project.id,
      userId: editor.id,
      conversationId: conv.id,
      baseDoc: joinedAfter1.doc as typeof EMPTY_DOC,
      baseVersion: joinedAfter1.version,
      noteId: 'n_ai_2',
      noteTitle: 'Second AI Note',
    });

    await rooms.apply(project.id, [
      { t: 'add', coll: 'notes', index: 1, item: { id: 'n_manual', title: 'Manual', content: 'M' } },
    ]);

    await expect(
      rooms.commitProposal({
        projectId: project.id,
        proposalId: prop2.id,
        revision: prop2.revision,
        user: editor,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ai_stale_proposal' });

    const joinedAfterConflict = await rooms.join(project.id);
    expect(joinedAfterConflict.version).toBe(2);
    expect(joinedAfterConflict.doc.notes?.map((n) => n.id)).toEqual(['n_ai_1', 'n_manual']);
  });

  it('rejects expired or superseded proposals, revokes access if membership is lost before commit, and rolls back cleanly on failure', async () => {
    const editor = await createUser(prisma, `editor2@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Rollback Project', diagram: EMPTY_DOC, createdBy: editor.id },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const repo = new AiRepository(prisma);
    const conv = await repo.createConversation({
      projectId: project.id,
      userId: editor.id,
      selectedModel: 'chat-a',
    });

    const expiredProp = await createPendingProposal({
      repo,
      projectId: project.id,
      userId: editor.id,
      conversationId: conv.id,
      baseDoc: EMPTY_DOC,
      baseVersion: 0,
      noteId: 'n_exp',
      noteTitle: 'Expired',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      rooms.commitProposal({
        projectId: project.id,
        proposalId: expiredProp.id,
        revision: expiredProp.revision,
        user: editor,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ai_expired_proposal' });

    const validProp = await createPendingProposal({
      repo,
      projectId: project.id,
      userId: editor.id,
      conversationId: conv.id,
      baseDoc: EMPTY_DOC,
      baseVersion: 0,
      noteId: 'n_valid',
      noteTitle: 'Valid',
    });

    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: project.id, userId: editor.id } },
      data: { role: 'viewer' },
    });

    await expect(
      rooms.commitProposal({
        projectId: project.id,
        proposalId: validProp.id,
        revision: validProp.revision,
        user: editor,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    const state = await rooms.join(project.id);
    expect(state.version).toBe(0);
    expect(state.doc.notes).toEqual([]);

    // Item 7: Revoked global admin (stale user.isAdmin = true snapshot in HTTP request, but DB isAdmin = false) must be denied inside transaction
    const tempAdmin = await createUser(prisma, `tempadmin@${ALLOWED_DOMAIN}`, { isAdmin: true });
    const adminConv = await repo.createConversation({
      projectId: project.id,
      userId: tempAdmin.id,
      selectedModel: 'chat-a',
    });
    const adminProp = await createPendingProposal({
      repo,
      projectId: project.id,
      userId: tempAdmin.id,
      conversationId: adminConv.id,
      baseDoc: EMPTY_DOC,
      baseVersion: 0,
      noteId: 'n_admin_revoked',
      noteTitle: 'Admin Revoked',
    });

    // Revoke admin in DB while passing stale tempAdmin (isAdmin: true) snapshot
    await prisma.user.update({
      where: { id: tempAdmin.id },
      data: { isAdmin: false },
    });

    await expect(
      rooms.commitProposal({
        projectId: project.id,
        proposalId: adminProp.id,
        revision: adminProp.revision,
        user: tempAdmin,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });


  it('broadcasts committed AI proposal ops to all Socket.IO clients (including requester) without emitting a local ack, and serializes with in-flight client ops without epoch', async () => {
    const { createServer } = await import('../../src/server');
    const { MemoryMailer } = await import('../../src/mail/mailer');
    const { TEST_CONFIG } = await import('../helpers/app');
    const { BackgroundTasks } = await import('../helpers/background');
    const { sessionCookie } = await import('../helpers/users');
    const { io: createClient } = await import('socket.io-client');

    const userA = await createUser(prisma, `socka@${ALLOWED_DOMAIN}`);
    const userB = await createUser(prisma, `sockb@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Collab AI Project', diagram: EMPTY_DOC, createdBy: userA.id },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: userA.id, role: 'editor' },
        { projectId: project.id, userId: userB.id, role: 'editor' },
      ],
    });

    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const background = new BackgroundTasks();
    const { http, io } = createServer({
      prisma,
      mailer: new MemoryMailer(),
      config: TEST_CONFIG,
      runInBackground: background.run,
      rooms,
    });

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const [cookieA, cookieB] = await Promise.all([
      sessionCookie(prisma, userA.id),
      sessionCookie(prisma, userB.id),
    ]);

    const clientA = createClient(baseUrl, {
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookieA, Origin: TEST_CONFIG.appUrl },
    });
    const clientB = createClient(baseUrl, {
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookieB, Origin: TEST_CONFIG.appUrl },
    });

    try {
      await Promise.all([
        new Promise<void>((res, rej) => {
          clientA.once('connect', () => res());
          clientA.once('connect_error', rej);
        }),
        new Promise<void>((res, rej) => {
          clientB.once('connect', () => res());
          clientB.once('connect_error', rej);
        }),
      ]);

      await Promise.all([
        new Promise<void>((res) => clientA.emit('join', { projectId: project.id }, () => res())),
        new Promise<void>((res) => clientB.emit('join', { projectId: project.id }, () => res())),
      ]);

      const repo = new AiRepository(prisma);
      const conv = await repo.createConversation({
        projectId: project.id,
        userId: userA.id,
        selectedModel: 'chat-a',
      });

      const prop = await createPendingProposal({
        repo,
        projectId: project.id,
        userId: userA.id,
        conversationId: conv.id,
        baseDoc: EMPTY_DOC,
        baseVersion: 0,
        noteId: 'n_socket_ai',
        noteTitle: 'Socket AI Note',
      });

      let unexpectedAckOnA = false;
      clientA.on('ack', () => {
        unexpectedAckOnA = true;
      });

      const opsOnAPromise = new Promise<{ version: number; ops: unknown[]; by: string }>((res) =>
        clientA.once('ops', res),
      );
      const opsOnBPromise = new Promise<{ version: number; ops: unknown[]; by: string }>((res) =>
        clientB.once('ops', res),
      );

      const commitRes = await rooms.commitProposal({
        projectId: project.id,
        proposalId: prop.id,
        revision: prop.revision,
        user: userA,
      });
      expect(commitRes.version).toBe(1);

      const [opsOnA, opsOnB] = await Promise.all([opsOnAPromise, opsOnBPromise]);
      expect(opsOnA.version).toBe(1);
      expect(opsOnA.by).toBe(userA.id);
      expect(opsOnB.version).toBe(1);
      expect(opsOnB.by).toBe(userA.id);
      expect(unexpectedAckOnA).toBe(false);

      // Client B sends a batch without epoch immediately after receiving the AI broadcast
      const ackOnBPromise = new Promise<{ seq: number; version: number; ok: boolean }>((res) =>
        clientB.once('ack', res),
      );
      clientB.emit('ops', {
        seq: 1,
        ops: [
          {
            t: 'add',
            coll: 'notes',
            index: 1,
            item: { id: 'n_b_followup', title: 'B Followup', content: 'After AI' },
          },
        ],
      });

      const ackB = await ackOnBPromise;
      expect(ackB).toEqual({ seq: 1, version: 2, ok: true });

      const finalRoom = await rooms.join(project.id);
      expect(finalRoom.version).toBe(2);
      expect(finalRoom.doc.notes?.map((n) => n.id)).toEqual(['n_socket_ai', 'n_b_followup']);
    } finally {
      clientA.disconnect();
      clientB.disconnect();
      await rooms.flushAll();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (http.listening) {
        await new Promise<void>((resolve) => http.close(() => resolve()));
      }
    }
  });
});


