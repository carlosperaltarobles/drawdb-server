import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../../src/ai/conversations';
import { AiRepository } from '../../src/ai/repository';
import type { ModelChoice } from '../../src/ai/types';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN } from '../helpers/app';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';

const prisma = testPrisma();

const fakeModelA: ModelChoice = {
  id: 'gemini-4-argon',
  label: 'Gemini 4 Argon',
  provider: 'litellm',
  capabilities: { chat: true, tools: true, json: true, stream: true },
  contextWindow: 128000,
  maxOutputTokens: 4096,
};

const fakeModelB: ModelChoice = {
  id: 'claude-sonnet',
  label: 'Claude Sonnet',
  provider: 'litellm',
  capabilities: { chat: true, tools: true, json: true, stream: true },
  contextWindow: 64000,
  maxOutputTokens: 2048,
};

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ConversationService and AiRepository privacy & lifecycle', () => {
  it('enforces per-user privacy within the same project, role checks, active generation lock on model change, and preserves snapshots on conversation delete', async () => {
    const admin = await createUser(prisma, `admin@${ALLOWED_DOMAIN}`, { isAdmin: true });
    const editorA = await createUser(prisma, `editora@${ALLOWED_DOMAIN}`);
    const editorB = await createUser(prisma, `editorb@${ALLOWED_DOMAIN}`);
    const viewer = await createUser(prisma, `viewer@${ALLOWED_DOMAIN}`);
    const outsider = await createUser(prisma, `outsider@${ALLOWED_DOMAIN}`);

    const project1 = await prisma.project.create({
      data: { name: 'Project 1', diagram: EMPTY_DOC, createdBy: admin.id },
    });
    const project2 = await prisma.project.create({
      data: { name: 'Project 2', diagram: EMPTY_DOC, createdBy: admin.id },
    });

    await prisma.projectMember.createMany({
      data: [
        { projectId: project1.id, userId: editorA.id, role: 'editor' },
        { projectId: project1.id, userId: editorB.id, role: 'editor' },
        { projectId: project1.id, userId: viewer.id, role: 'viewer' },
        { projectId: project2.id, userId: editorA.id, role: 'editor' },
      ],
    });

    const cancelSpy = vi.fn();
    const repo = new AiRepository(prisma);
    const service = new ConversationService({
      prisma,
      repo,
      resolveModel: async (id) => (id === 'claude-sonnet' ? fakeModelB : fakeModelA),
      getDefaultModel: async () => 'gemini-4-argon',
      onCancelConversationGenerations: cancelSpy,
    });

    await expect(service.list(project1.id, outsider)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.create(project1.id, outsider, {})).rejects.toMatchObject({
      code: 'not_found',
    });

    const viewerConv = await service.create(project1.id, viewer, {});
    expect(viewerConv.selectedModel).toBe('gemini-4-argon');

    const convA1 = await service.create(project1.id, editorA, { selectedModel: 'gemini-4-argon' });
    const convA2 = await service.create(project2.id, editorA, { selectedModel: 'claude-sonnet' });

    const listB = await service.list(project1.id, editorB);
    expect(listB.items).toHaveLength(0);
    await expect(service.getMessages(project1.id, convA1.id, editorB)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      service.setModel(project1.id, convA1.id, editorB, { selectedModel: 'claude-sonnet' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(service.getMessages(project1.id, convA2.id, editorA)).rejects.toMatchObject({
      code: 'not_found',
    });

    const { userMessage, assistantMessage, generation } = await repo.createGenerationTurn({
      conversationId: convA1.id,
      projectId: project1.id,
      userId: editorA.id,
      requestId: '0199aaaa-0000-7000-8000-000000000010',
      userContent: 'Agrega tabla pagos',
      requestedModel: 'gemini-4-argon',
    });
    expect(userMessage.status).toBe('complete');
    expect(assistantMessage.status).toBe('pending');

    await expect(
      service.setModel(project1.id, convA1.id, editorA, { selectedModel: 'claude-sonnet' }),
    ).rejects.toMatchObject({ status: 409, code: 'ai_busy' });

    const snapshot = await prisma.projectSnapshot.create({
      data: {
        projectId: project1.id,
        diagram: EMPTY_DOC,
        version: 0n,
        kind: 'pre_ai_apply',
        createdBy: editorA.id,
      },
    });

    const proposal = await repo.saveProposal({
      conversationId: convA1.id,
      projectId: project1.id,
      userId: editorA.id,
      generationId: generation.id,
      requestedModel: 'gemini-4-argon',
      reportedModel: 'gemini-4-argon-001',
      baseDoc: EMPTY_DOC,
      afterDoc: EMPTY_DOC,
      ops: [],
      baseVersion: 0,
      baseHash: 'hash0',
      summary: { counts: { added: 1, modified: 0, removed: 0 }, items: [] },
      warnings: [],
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await prisma.aiProposal.update({
      where: { id: proposal.id },
      data: { status: 'applied', appliedVersion: 1n, snapshotId: snapshot.id },
    });

    await repo.completeGeneration({
      generationId: generation.id,
      assistantMessageId: assistantMessage.id,
      content: 'Propuesta lista.',
      reportedModel: 'gemini-4-argon-001',
      usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
      proposalId: proposal.id,
    });

    const updatedConv = await service.setModel(project1.id, convA1.id, editorA, {
      selectedModel: 'claude-sonnet',
    });
    expect(updatedConv.selectedModel).toBe('claude-sonnet');

    const msgPage = await service.getMessages(project1.id, convA1.id, editorA, { limit: 1 });
    expect(msgPage.items).toHaveLength(1);
    expect(msgPage.nextCursor).toBeTruthy();
    const msgPage2 = await service.getMessages(project1.id, convA1.id, editorA, {
      cursor: msgPage.nextCursor!,
      limit: 10,
    });
    expect(msgPage2.items).toHaveLength(1);

    await service.remove(project1.id, convA1.id, editorA);
    expect(cancelSpy).toHaveBeenCalledWith(convA1.id);

    const remainingSnap = await prisma.projectSnapshot.findUnique({ where: { id: snapshot.id } });
    expect(remainingSnap).not.toBeNull();
    expect(remainingSnap?.kind).toBe('pre_ai_apply');
  });
});

