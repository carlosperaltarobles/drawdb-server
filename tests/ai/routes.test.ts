import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import type { AiProvider, ModelCatalog, ProviderEvent, ProviderInput } from '../../src/ai/types';
import { RoomManager } from '../../src/collab/rooms';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser, sessionCookie } from '../helpers/users';
import protocolFixture from './fixtures/protocol.json';

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('/api/projects/:id/ai HTTP routes, SSE replay, CSRF, and feature discovery', () => {
  it('returns 503 ai_disabled when AI is disabled while still enforcing 401 and 404 access checks', async () => {
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const { app } = await makeApp({
      rooms,
      history: rooms,
      config: {
        ai: parseAiConfig({ AI_ENABLED: 'false' }),
      },
    });

    const editor = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
    const outsider = await createUser(prisma, `outsider@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Disabled AI Project', diagram: EMPTY_DOC, createdBy: editor.id },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: editor.id, role: 'editor' },
    });

    const [editorCookie, outsiderCookie] = await Promise.all([
      sessionCookie(prisma, editor.id),
      sessionCookie(prisma, outsider.id),
    ]);

    const unauth = await request(app).get(`/api/projects/${project.id}/ai/models`);
    expect(unauth.status).toBe(401);

    const noAccess = await request(app)
      .get(`/api/projects/${project.id}/ai/models`)
      .set('Cookie', outsiderCookie);
    expect(noAccess.status).toBe(404);

    const disabledRes = await request(app)
      .get(`/api/projects/${project.id}/ai/models`)
      .set('Cookie', editorCookie);
    expect(disabledRes.status).toBe(503);
    expect(disabledRes.body).toEqual({ error: 'ai_disabled' });
  });

  it('serves all contract routes, enforces CSRF same-origin on mutations, replays SSE with Last-Event-ID, and delegates applyProposal', async () => {
    const fakeProvider: AiProvider = {
      async listModels(): Promise<ModelCatalog> {
        return protocolFixture.catalog as ModelCatalog;
      },
      async *generate(_input: ProviderInput): AsyncIterable<ProviderEvent> {
        yield { type: 'text', delta: 'Esquema revisado.' };
        yield {
          type: 'tool_call',
          id: 'tc_prop',
          name: 'propose_changes',
          arguments: {
            ops: [
              {
                t: 'add',
                coll: 'notes',
                index: 0,
                item: { id: 'note-a', title: 'Review', content: 'Note content' },
              },
            ],
          },
        };
        yield { type: 'done', reportedModel: 'fixture-chat-a', finishReason: 'tool_calls' };
      },
    };

    const commitSpy = vi.fn().mockResolvedValue({
      proposalId: 'prop-1',
      revision: 1,
      version: 1,
      snapshotId: 'snap-1',
      applied: true as const,
    });

    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const aiCfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test',
      LITELLM_MODEL: 'chat-a',
    });

    const { app } = await makeApp({
      rooms,
      history: rooms,
      config: { ai: aiCfg },
      ai: {
        provider: fakeProvider,
        commitProposal: commitSpy,
      },
    });

    const editor = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
    const otherEditor = await createUser(prisma, `other@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: { name: 'Routes Project', diagram: EMPTY_DOC, createdBy: editor.id },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: editor.id, role: 'editor' },
        { projectId: project.id, userId: otherEditor.id, role: 'editor' },
      ],
    });

    const [editorCookie, otherCookie] = await Promise.all([
      sessionCookie(prisma, editor.id),
      sessionCookie(prisma, otherEditor.id),
    ]);

    const modelsRes = await request(app)
      .get(`/api/projects/${project.id}/ai/models`)
      .set('Cookie', editorCookie);
    expect(modelsRes.status).toBe(200);
    expect(modelsRes.body.defaultModel).toBe('chat-a');
    expect(modelsRes.body.items).toHaveLength(2);

    const csrfRes = await request(app)
      .post(`/api/projects/${project.id}/ai/conversations`)
      .set('Cookie', editorCookie)
      .set('Origin', 'https://evil.example.com')
      .send({ selectedModel: 'chat-a' });
    expect(csrfRes.status).toBe(403);
    expect(csrfRes.body).toEqual({ error: 'forbidden' });

    const badModelRes = await request(app)
      .post(`/api/projects/${project.id}/ai/conversations`)
      .set('Cookie', editorCookie)
      .send({ selectedModel: 'arbitrary-model-id' });
    expect(badModelRes.status).toBe(409);
    expect(badModelRes.body).toEqual({ error: 'ai_model_unavailable' });

    const createConv = await request(app)
      .post(`/api/projects/${project.id}/ai/conversations`)
      .set('Cookie', editorCookie)
      .send({ selectedModel: 'chat-a' });
    expect(createConv.status).toBe(201);
    const cid = createConv.body.id as string;

    const foreignPatch = await request(app)
      .patch(`/api/projects/${project.id}/ai/conversations/${cid}`)
      .set('Cookie', otherCookie)
      .send({ selectedModel: 'chat-b' });
    expect(foreignPatch.status).toBe(404);

    const sendRes = await request(app)
      .post(`/api/projects/${project.id}/ai/conversations/${cid}/messages`)
      .set('Cookie', editorCookie)
      .send({
        content: 'Agrega una nota de revisión',
        requestId: '0199aaaa-0000-7000-8000-000000000333',
      });
    expect(sendRes.status).toBe(202);
    const gid = sendRes.body.generationId as string;

    const sseRes = await request(app)
      .get(`/api/projects/${project.id}/ai/generations/${gid}/events`)
      .set('Cookie', editorCookie);
    expect(sseRes.status).toBe(200);
    expect(sseRes.text).toContain('event: generation');
    expect(sseRes.text).toContain('event: text');
    expect(sseRes.text).toContain('event: proposal');
    expect(sseRes.text).toContain('event: done');

    const replayRes = await request(app)
      .get(`/api/projects/${project.id}/ai/generations/${gid}/events`)
      .set('Cookie', editorCookie)
      .set('Last-Event-ID', '2');
    expect(replayRes.status).toBe(200);
    expect(replayRes.text).not.toContain('id: 1\n');
    expect(replayRes.text).toContain('event: done');

    const genStatus = await request(app)
      .get(`/api/projects/${project.id}/ai/generations/${gid}`)
      .set('Cookie', editorCookie);
    expect(genStatus.status).toBe(200);
    expect(genStatus.body.status).toBe('complete');
    const pid = genStatus.body.proposalId as string;
    expect(pid).toBeTruthy();

    const propDetail = await request(app)
      .get(`/api/projects/${project.id}/ai/proposals/${pid}`)
      .set('Cookie', editorCookie);
    expect(propDetail.status).toBe(200);
    expect(propDetail.body.proposal.id).toBe(pid);
    expect(propDetail.body.after.notes).toHaveLength(1);

    const applyRes = await request(app)
      .post(`/api/projects/${project.id}/ai/proposals/${pid}/apply`)
      .set('Cookie', editorCookie)
      .send({ revision: 1 });
    expect(applyRes.status).toBe(200);
    expect(commitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        proposalId: pid,
        revision: 1,
      }),
    );
  });
});

