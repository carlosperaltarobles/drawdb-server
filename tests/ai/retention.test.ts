import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AiRepository } from '../../src/ai/repository';
import { pruneAiData, recoverOrphanedGenerations } from '../../src/ai/retention';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN } from '../helpers/app';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';

const prisma = testPrisma();
const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AI retention, proposal TTL expiration, and orphan recovery', () => {
  it('expires pending proposals after 24h, prunes conversations inactive for >30 days without touching active work, and recovers orphaned generations on startup', async () => {
    const user = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Retention Project', diagram: EMPTY_DOC, createdBy: user.id },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: 'editor' },
    });

    const repo = new AiRepository(prisma);

    // 1. Old inactive conversation (31 days ago) -> should be pruned
    const oldConv = await prisma.aiConversation.create({
      data: {
        projectId: project.id,
        userId: user.id,
        selectedModel: 'gemini-4-argon',
        createdAt: new Date(NOW.getTime() - 32 * DAY_MS),
        updatedAt: new Date(NOW.getTime() - 31 * DAY_MS),
      },
    });

    // 2. Recent conversation (2 days ago) with an expired pending proposal (25 hours old)
    const activeConv = await prisma.aiConversation.create({
      data: {
        projectId: project.id,
        userId: user.id,
        selectedModel: 'gemini-4-argon',
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
        updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      },
    });

    const expiredProp = await repo.saveProposal({
      conversationId: activeConv.id,
      projectId: project.id,
      userId: user.id,
      requestedModel: 'gemini-4-argon',
      reportedModel: 'gemini-4-argon',
      baseDoc: EMPTY_DOC,
      afterDoc: EMPTY_DOC,
      ops: [],
      baseVersion: 0,
      baseHash: 'h0',
      summary: { counts: { added: 1, modified: 0, removed: 0 }, items: [] },
      warnings: [],
      expiresAt: new Date(NOW.getTime() - 1 * HOUR_MS),
    });

    // 3. Old conversation (35 days ago) that STILL has a running generation -> must NOT be deleted while running
    const busyOldConv = await prisma.aiConversation.create({
      data: {
        projectId: project.id,
        userId: user.id,
        selectedModel: 'gemini-4-argon',
        createdAt: new Date(NOW.getTime() - 35 * DAY_MS),
        updatedAt: new Date(NOW.getTime() - 35 * DAY_MS),
      },
    });
    const turn = await repo.createGenerationTurn({
      conversationId: busyOldConv.id,
      projectId: project.id,
      userId: user.id,
      requestId: '0199aaaa-0000-7000-8000-000000000099',
      userContent: 'Long running',
      requestedModel: 'gemini-4-argon',
    });

    const pruneRes = await pruneAiData(prisma, NOW);
    expect(pruneRes.expiredProposals).toBe(1);
    expect(pruneRes.deletedConversations).toBe(1);

    expect(await prisma.aiConversation.findUnique({ where: { id: oldConv.id } })).toBeNull();
    expect(await prisma.aiConversation.findUnique({ where: { id: activeConv.id } })).not.toBeNull();
    expect(await prisma.aiConversation.findUnique({ where: { id: busyOldConv.id } })).not.toBeNull();

    const afterProp = await prisma.aiProposal.findUniqueOrThrow({ where: { id: expiredProp.id } });
    expect(afterProp.status).toBe('expired');

    // Recover orphaned generations on server restart
    const recoveredCount = await recoverOrphanedGenerations(prisma);
    expect(recoveredCount).toBe(1);

    const recoveredGen = await prisma.aiGeneration.findUniqueOrThrow({
      where: { id: turn.generation.id },
    });
    expect(recoveredGen.status).toBe('failed');
    expect(recoveredGen.errorCode).toBe('ai_unavailable');

    const recoveredMsg = await prisma.aiMessage.findUniqueOrThrow({
      where: { id: turn.assistantMessage.id },
    });
    expect(recoveredMsg.status).toBe('failed');
  });
});
