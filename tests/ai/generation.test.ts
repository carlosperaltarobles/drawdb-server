import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import { AiGenerationService } from '../../src/ai/generation';
import { GenerationRegistry } from '../../src/ai/generation-registry';
import { ModelCatalogService } from '../../src/ai/models';
import { createProjectSource } from '../../src/ai/project-source';
import { AiRepository } from '../../src/ai/repository';
import type { AiProvider, ModelCatalog, ModelChoice, ProviderEvent, ProviderInput } from '../../src/ai/types';
import { RoomManager } from '../../src/collab/rooms';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { ALLOWED_DOMAIN } from '../helpers/app';
import { resetDb, testPrisma } from '../helpers/db';
import { createUser } from '../helpers/users';

const prisma = testPrisma();

const chatModelTools: ModelChoice = {
  id: 'chat-a',
  label: 'Chat A',
  provider: 'fixture',
  capabilities: { chat: true, tools: true, json: true, stream: true },
  contextWindow: 32768,
  maxOutputTokens: 2048,
};

const chatModelJsonOnly: ModelChoice = {
  id: 'chat-json',
  label: 'Chat JSON',
  provider: 'fixture',
  capabilities: { chat: true, tools: false, json: true, stream: false },
  contextWindow: 16384,
  maxOutputTokens: 1024,
};

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AiGenerationService orchestration, tool rounds, JSON repair, staging, and idempotency', () => {
  it('executes read tools + propose_changes for editors, restricts viewers from proposing, supports 1 structured repair, and handles idempotent requestId', async () => {
    const editor = await createUser(prisma, `editor@${ALLOWED_DOMAIN}`);
    const viewer = await createUser(prisma, `viewer@${ALLOWED_DOMAIN}`);
    const project = await prisma.project.create({
      data: {
        name: 'Gen Project',
        diagram: {
          ...EMPTY_DOC,
          database: 'postgresql',
          tables: [
            {
              id: 't1',
              name: 'users',
              x: 0,
              y: 0,
              comment: '',
              color: '#175e7a',
              indices: [],
              uniqueConstraints: [],
              fields: [
                {
                  id: 'f1',
                  name: 'id',
                  type: 'INTEGER',
                  default: '',
                  check: '',
                  primary: true,
                  unique: true,
                  notNull: true,
                  increment: true,
                  comment: '',
                },
              ],
            },
          ],
        },
        createdBy: editor.id,
      },
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: editor.id, role: 'editor' },
        { projectId: project.id, userId: viewer.id, role: 'viewer' },
      ],
    });

    const seenInputs: ProviderInput[] = [];
    let callNum = 0;

    const fakeProvider: AiProvider = {
      async listModels(): Promise<ModelCatalog> {
        return {
          items: [chatModelTools, chatModelJsonOnly],
          fetchedAt: new Date().toISOString(),
          stale: false,
          defaultModel: 'chat-a',
        };
      },
      async *generate(input: ProviderInput): AsyncIterable<ProviderEvent> {
        seenInputs.push(input);
        callNum++;
        if (callNum === 1) {
          yield {
            type: 'tool_call',
            id: 'call_search',
            name: 'search_entities',
            arguments: { query: 'users' },
          };
          yield { type: 'done', reportedModel: 'fixture-chat-a', finishReason: 'tool_calls' };
          return;
        }
        if (callNum === 2) {
          yield {
            type: 'tool_call',
            id: 'call_bad_prop',
            name: 'propose_changes',
            arguments: {
              ops: [{ t: 'patch', coll: 'tables', id: 't1', patch: { unknownKey: 123 } }],
            },
          };
          yield { type: 'done', reportedModel: 'fixture-chat-a', finishReason: 'tool_calls' };
          return;
        }
        if (callNum === 3) {
          yield { type: 'text', delta: 'He preparado la nota solicitada.' };
          yield {
            type: 'tool_call',
            id: 'call_good_prop',
            name: 'propose_changes',
            arguments: {
              warnings: ['Revisión recomendada'],
              ops: [
                {
                  t: 'add',
                  coll: 'notes',
                  index: 0,
                  item: { id: 'note-a', title: 'Review', content: 'Check users' },
                },
              ],
            },
          };
          yield {
            type: 'usage',
            usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
          };
          yield { type: 'done', reportedModel: 'fixture-chat-a', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text', delta: 'Explicación para viewer.' };
        yield { type: 'done', reportedModel: 'fixture-chat-a', finishReason: 'stop' };
      },
    };

    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test',
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });
    const repo = new AiRepository(prisma);
    const catalog = new ModelCatalogService({ provider: fakeProvider, config: cfg });
    const registry = new GenerationRegistry(cfg);
    const service = new AiGenerationService({
      prisma,
      config: cfg,
      provider: fakeProvider,
      catalog,
      repo,
      registry,
      rooms: createProjectSource(rooms),
    });

    const editorConv = await repo.createConversation({
      projectId: project.id,
      userId: editor.id,
      selectedModel: 'chat-a',
    });

    const reqId = '0199aaaa-0000-7000-8000-000000000111';
    const start1 = await service.start(project.id, editorConv.id, editor, {
      content: 'Agrega una nota de revisión',
      requestId: reqId,
    });
    const startDup = await service.start(project.id, editorConv.id, editor, {
      content: 'Agrega una nota de revisión',
      requestId: reqId,
    });
    expect(startDup.generationId).toBe(start1.generationId);

    const status = await service.waitForCompletion(start1.generationId);
    expect(status?.status).toBe('complete');
    expect(status?.proposalId).toBeTruthy();

    const detail = await service.getProposalDetail(project.id, status!.proposalId!, editor);
    expect(detail.stale).toBe(false);
    expect(detail.proposal.summary.counts.added).toBe(1);
    expect(detail.after.notes).toHaveLength(1);

    const viewerConv = await repo.createConversation({
      projectId: project.id,
      userId: viewer.id,
      selectedModel: 'chat-a',
    });
    const viewerStart = await service.start(project.id, viewerConv.id, viewer, {
      content: 'Explica la tabla users',
      requestId: '0199aaaa-0000-7000-8000-000000000222',
    });
    await service.waitForCompletion(viewerStart.generationId);

    const lastInput = seenInputs[seenInputs.length - 1]!;
    expect(lastInput.tools.some((t) => t.name === 'propose_changes')).toBe(false);

    // Item 2: Verify round 2 of the active generation preserved assistant.toolCalls + tool_result.toolCallId linkage
    const round2Messages = seenInputs[1]!.messages;
    const assistantToolMsg = round2Messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    expect(assistantToolMsg).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_search', name: 'search_entities', arguments: { query: 'users' } }],
    });
    const linkedToolResult = round2Messages.find(
      (m) => m.role === 'tool_result' && m.toolCallId === 'call_search',
    );
    expect(linkedToolResult).toMatchObject({
      role: 'tool_result',
      toolCallId: 'call_search',
      toolName: 'search_entities',
    });

    // Item 5: Deleting conversation while generation is in-flight does not cause unhandled rejection
    let releaseSlowProvider!: () => void;
    const slowProviderStarted = new Promise<void>((res) => {
      releaseSlowProvider = res;
    });
    let allowProviderFinish!: () => void;
    const providerWait = new Promise<void>((res) => {
      allowProviderFinish = res;
    });

    const slowProvider: AiProvider = {
      async listModels() {
        return {
          items: [chatModelTools],
          fetchedAt: new Date().toISOString(),
          stale: false,
          defaultModel: 'chat-a',
        };
      },
      async *generate(): AsyncIterable<ProviderEvent> {
        releaseSlowProvider();
        await providerWait;
        yield { type: 'text', delta: 'Late response after delete' };
        yield { type: 'done', reportedModel: 'chat-a', finishReason: 'stop' };
      },
    };

    const serviceSlow = new AiGenerationService({
      prisma,
      config: cfg,
      provider: slowProvider,
      catalog,
      repo,
      registry,
      rooms: createProjectSource(rooms),
    });

    const tempConv = await repo.createConversation({
      projectId: project.id,
      userId: editor.id,
      selectedModel: 'chat-a',
    });
    const slowGen = await serviceSlow.start(project.id, tempConv.id, editor, {
      content: 'Will be deleted mid-flight',
      requestId: '0199aaaa-0000-7000-8000-000000000999',
    });
    await slowProviderStarted;
    await repo.deleteConversation(project.id, tempConv.id, editor.id);
    allowProviderFinish();
    await serviceSlow.waitForCompletion(slowGen.generationId);
  });
});


