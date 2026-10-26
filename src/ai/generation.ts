import type { Response } from 'express';
import type { PublicUser } from '../auth/public-user';
import type { Coll, Document, Id } from '../collab/ops';
import type { PrismaClient } from '../db/prisma';
import { AppError } from '../http/app-error';
import type { RunInBackground } from '../http/background';
import { getRole, type AccessRole } from '../projects/repo';
import type { AiConfig } from './config';
import { queryContext } from './context';
import { DocumentIndexCache } from './document-index';
import type { GenerationRegistry, SseEnvelope } from './generation-registry';
import type { ModelCatalogService } from './models';
import type { AiRooms } from './project-source';
import { prepareProposal } from './proposal-validation';
import { PROPOSAL_TTL_MS, toProposalDto, type AiRepository } from './repository';
import type {
  AiProvider,
  CanonicalMessage,
  ProposalDetail,
  ScopeEntity,
  ToolDefinition,
} from './types';

export type AiGenerationServiceDeps = {
  prisma: PrismaClient;
  config: AiConfig;
  provider: AiProvider;
  catalog: ModelCatalogService;
  repo: AiRepository;
  registry: GenerationRegistry;
  rooms: AiRooms;
  runInBackground?: RunInBackground;
  indexCache?: DocumentIndexCache;
  now?: () => Date;
};


const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'search_entities',
    description: 'Search tables, views, types, enums, notes or areas by keyword or paginate catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'get_entity_details',
    description: 'Fetch detailed definition of specific diagram entities by collection and id.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              coll: { type: 'string' },
              id: { type: ['string', 'number'] },
            },
            required: ['coll', 'id'],
          },
        },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'get_entity_fields',
    description: 'Paginate fields of a large table by id.',
    parameters: {
      type: 'object',
      properties: {
        tableId: { type: ['string', 'number'] },
        query: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['tableId'],
    },
  },
  {
    name: 'get_neighbors',
    description: 'Fetch incoming/outgoing foreign keys, views and dependencies for entities.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              coll: { type: 'string' },
              id: { type: ['string', 'number'] },
            },
            required: ['coll', 'id'],
          },
        },
        direction: { type: 'string', enum: ['in', 'out', 'both'] },
        cursor: { type: 'string' },
      },
      required: ['ids'],
    },
  },
];

const PROPOSE_TOOL: ToolDefinition = {
  name: 'propose_changes',
  description:
    'Propose a complete, atomic batch of drawDB diagram operations (add, patch, del, order, sadd, spatch, sdel, sorder). Never use set.',
  parameters: {
    type: 'object',
    properties: {
      ops: { type: 'array', items: { type: 'object' } },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['ops'],
  },
};

function encodeContinuation(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeContinuation(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('invalid_input');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('invalid_input');
  }
}

function parseScopeEntities(raw: unknown): ScopeEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopeEntity[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { coll?: unknown }).coll === 'string' &&
      (typeof (item as { id?: unknown }).id === 'string' ||
        typeof (item as { id?: unknown }).id === 'number')
    ) {
      out.push({
        coll: (item as { coll: Coll }).coll,
        id: (item as { id: Id }).id,
      });
    }
  }
  return out;
}

export class AiGenerationService {
  private readonly indexCache: DocumentIndexCache;
  private readonly now: () => Date;
  private readonly runInBackground: RunInBackground;

  constructor(private readonly deps: AiGenerationServiceDeps) {
    this.indexCache = deps.indexCache ?? new DocumentIndexCache();
    this.now = deps.now ?? (() => new Date());
    this.runInBackground =
      deps.runInBackground ??
      ((task) => {
        void task().catch((err) => {
          console.error('Background AI generation failed:', err);
        });
      });
  }


  private async requireProjectAccess(projectId: string, user: PublicUser): Promise<AccessRole> {
    const role = await getRole(this.deps.prisma, projectId, user);
    if (!role) throw new AppError('not_found');
    return role;
  }

  async start(
    projectId: string,
    conversationId: string,
    user: PublicUser,
    input: { content: string; requestId: string; continuation?: string },
  ): Promise<{ generationId: string }> {
    const role = await this.requireProjectAccess(projectId, user);
    if (!this.deps.config.enabled) {
      throw new AppError('ai_disabled');
    }

    if (input.content.length > this.deps.config.maxMessageChars) {
      throw new AppError('invalid_input');
    }

    const conv = await this.deps.repo.getConversationOwned(projectId, conversationId, user.id);

    // Check idempotent requestId before reserving new rate/concurrency slots
    const existingGen = await this.deps.repo.findGenerationByRequestId({
      conversationId,
      projectId,
      userId: user.id,
      requestId: input.requestId,
    });
    if (existingGen) {
      return { generationId: existingGen.id };
    }

    const selectedModelId = conv.selectedModel ?? this.deps.config.defaultModel;
    if (!selectedModelId) {
      throw new AppError('ai_model_unavailable');
    }
    const model = await this.deps.catalog.resolveModel(selectedModelId, {
      userId: user.id,
      policyScope: `project:${projectId}`,
    });

    // Validate continuation token against current project state if provided
    const baseSnapshot = await this.deps.rooms.read(projectId);
    let resumedContinuation: Record<string, unknown> | null = null;
    if (input.continuation) {
      resumedContinuation = decodeContinuation(input.continuation);
      if (
        resumedContinuation.baseHash !== undefined &&
        resumedContinuation.baseHash !== baseSnapshot.baseHash &&
        resumedContinuation.kind !== 'staged_ops'
      ) {
        throw new AppError('ai_stale_proposal');
      }
    }

    // Reserve concurrency and rate-limit slot before calling provider; release in finally
    const turn = await this.deps.repo.createGenerationTurn({
      conversationId,
      projectId,
      userId: user.id,
      requestId: input.requestId,
      userContent: input.content,
      requestedModel: model.id,
    });

    if (turn.alreadyExists) {
      return { generationId: turn.generation.id };
    }

    let handle: ReturnType<GenerationRegistry['acquire']>;
    try {
      handle = this.deps.registry.acquire({
        generationId: turn.generation.id,
        conversationId,
        projectId,
        userId: user.id,
        messageId: turn.assistantMessage.id,
        requestedModel: model.id,
      });
    } catch (err) {
      await this.deps.repo.failOrCancelGeneration({
        generationId: turn.generation.id,
        assistantMessageId: turn.assistantMessage.id,
        status: 'failed',
        errorCode: err instanceof AppError ? err.code : 'ai_busy',
      });
      throw err;
    }

    handle.publish({
      event: 'generation',
      data: {
        generationId: turn.generation.id,
        messageId: turn.assistantMessage.id,
        requestedModel: model.id,
      },
    });

    this.runInBackground(() =>
      this.runGenerationLoop({
        projectId,
        conversationId,
        user,
        role,
        model,
        generationId: turn.generation.id,
        userMessageId: turn.userMessage.id,
        assistantMessageId: turn.assistantMessage.id,
        userContent: input.content,
        baseDoc: baseSnapshot.doc,
        baseVersion: baseSnapshot.version,
        baseHash: baseSnapshot.baseHash,
        resumedContinuation,
        handle,
      }),
    );


    return { generationId: turn.generation.id };
  }

  async waitForCompletion(generationId: string): Promise<{
    id: string;
    status: string;
    messageId: string;
    proposalId: string | null;
    error: string | null;
    continuation: string | null;
  } | null> {
    const entry = this.deps.registry.getEntry(generationId);
    if (entry) {
      await entry.completionPromise;
    }
    const row = await this.deps.prisma.aiGeneration.findUnique({
      where: { id: generationId },
    });
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      messageId: row.assistantMessageId,
      proposalId: row.proposalId,
      error: row.errorCode,
      continuation:
        row.continuation && typeof row.continuation === 'object'
          ? encodeContinuation(row.continuation as Record<string, unknown>)
          : null,
    };
  }

  private async runGenerationLoop(params: {
    projectId: string;
    conversationId: string;
    user: PublicUser;
    role: AccessRole;
    model: import('./types').ModelChoice;
    generationId: string;
    userMessageId: string;
    assistantMessageId: string;
    userContent: string;
    baseDoc: Document;
    baseVersion: number;
    baseHash: string;
    resumedContinuation: Record<string, unknown> | null;
    handle: ReturnType<GenerationRegistry['acquire']>;
  }): Promise<void> {
    const {
      projectId,
      conversationId,
      user,
      role,
      model,
      generationId,
      userMessageId,
      assistantMessageId,
      userContent,
      baseDoc,
      baseVersion,
      baseHash,
      resumedContinuation,
      handle,
    } = params;

    let accumulatedText = '';
    let reportedModel: string | null = null;
    let latestUsage: Record<string, unknown> | null = null;
    let createdProposalId: string | null = null;
    let continuationPayload: Record<string, unknown> | null = null;

    try {
      const canUserEdit = role === 'admin' || role === 'editor';
      const canModelPropose = this.deps.catalog.canPropose(model);
      const allowPropose = canUserEdit && canModelPropose;

      const index = this.indexCache.getOrCreate(projectId, baseDoc, baseVersion);
      const contextBudget: {
        maxBytes: number;
        maxTokens: number;
        reserveOutputTokens: number;
        usedPromptTokens?: number;
      } = {
        maxBytes: this.deps.config.maxContextBytesPerCall,
        maxTokens: model.contextWindow ?? this.deps.config.conservativeContextWindow,
        reserveOutputTokens:
          model.maxOutputTokens ?? this.deps.config.conservativeMaxOutputTokens,
        usedPromptTokens: 0,
      };

      const initialPage = queryContext(
        index,
        {
          part: 'relevant',
          query: userContent,
          limit: this.deps.config.defaultPageSize,
          cursor:
            typeof resumedContinuation?.cursor === 'string'
              ? resumedContinuation.cursor
              : undefined,
        },
        contextBudget,
      );

      handle.publish({
        event: 'progress',
        data: {
          reviewed: initialPage.coverage.reviewed,
          remaining: initialPage.coverage.remaining,
          scope: initialPage.scope,
          baseVersion,
        },
      });

      const recentRows = await this.deps.prisma.aiMessage.findMany({
        where: {
          conversationId,
          status: 'complete',
          id: { notIn: [assistantMessageId, userMessageId] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: this.deps.config.maxRecentMessages,
      });
      const historyMessages = recentRows.reverse();

      const systemInstruction = [
        `Eres el asistente de diagramas de base de datos para drawDB. Motor del proyecto: ${index.database} (no cambies database ni sqlHeader).`,
        `Versión base: ${baseVersion}. Entidades totales: ${index.orderedEntities.length} (revisadas: ${initialPage.coverage.reviewed}, pendientes: ${initialPage.coverage.remaining}).`,
        allowPropose
          ? model.capabilities.tools === true
            ? 'Analiza con herramientas de lectura y propón cambios llamando a `propose_changes`.'
            : 'Responde con un objeto JSON {"text": string, "warnings": string[], "ops": Op[]} cuando propongas cambios.'
          : 'Modo solo análisis y conversación (sin propuestas de modificación).',
        `Contexto inicial del esquema:\n${JSON.stringify(initialPage.items)}`,
      ].join('\n');

      const messages: CanonicalMessage[] = [{ role: 'system', content: systemInstruction }];
      for (const m of historyMessages) {
        if (m.role === 'user' || m.role === 'assistant') {
          messages.push({
            role: m.role,
            content: m.content.slice(0, this.deps.config.maxMessageChars),
          });
        }
      }
      messages.push({ role: 'user', content: userContent });

      const mode: 'tools' | 'json' | 'text' =
        model.capabilities.tools === true
          ? 'tools'
          : allowPropose && model.capabilities.json === true
            ? 'json'
            : 'text';

      const tools: ToolDefinition[] =
        mode === 'tools' ? (allowPropose ? [...READ_TOOLS, PROPOSE_TOOL] : [...READ_TOOLS]) : [];

      let repairUsed = false;
      let rawProposalCandidate: unknown = null;
      let rounds = 0;

      while (rounds < this.deps.config.maxRounds) {
        if (handle.signal.aborted) throw new Error('aborted');
        rounds++;
        const toolCallsThisRound: Array<{
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];
        let roundText = '';

        for await (const ev of this.deps.provider.generate(
          {
            model,
            messages,
            tools,
            mode,
            maxOutputTokens:
              model.maxOutputTokens ?? this.deps.config.conservativeMaxOutputTokens,
          },
          handle.signal,
        )) {
          if (handle.signal.aborted) throw new Error('aborted');
          if (ev.type === 'text') {
            roundText += ev.delta;
            if (mode !== 'json') {
              accumulatedText += ev.delta;
              handle.publish({ event: 'text', data: { delta: ev.delta } });
            }
          } else if (ev.type === 'tool_call') {
            toolCallsThisRound.push({
              id: ev.id,
              name: ev.name,
              arguments: ev.arguments,
            });
          } else if (ev.type === 'usage') {
            latestUsage = ev.usage;
            if (typeof ev.usage.promptTokens === 'number' && Number.isFinite(ev.usage.promptTokens)) {
              contextBudget.usedPromptTokens = Math.max(
                contextBudget.usedPromptTokens ?? 0,
                ev.usage.promptTokens,
              );
            }
          } else if (ev.type === 'done' && ev.reportedModel) {
            reportedModel = ev.reportedModel;
          }
        }

        if (mode === 'json' && roundText.trim()) {
          try {
            const parsedJson = JSON.parse(roundText.trim()) as Record<string, unknown>;
            if (typeof parsedJson.text === 'string' && parsedJson.text) {
              accumulatedText += parsedJson.text;
              handle.publish({ event: 'text', data: { delta: parsedJson.text } });
            }
            if (Array.isArray(parsedJson.ops) && parsedJson.ops.length > 0 && allowPropose) {
              rawProposalCandidate = parsedJson;
            }
          } catch (err) {
            if (!repairUsed) {
              repairUsed = true;
              messages.push({ role: 'assistant', content: roundText });
              messages.push({
                role: 'user',
                content:
                  'Tu respuesta JSON anterior fue inválida. Corrige y devuelve únicamente JSON válido con {"text", "warnings", "ops"}.',
              });
              continue;
            }
            throw err instanceof AppError ? err : new AppError('ai_invalid_proposal');
          }
        }

        const proposeCall = toolCallsThisRound.find((tc) => tc.name === 'propose_changes');
        if (proposeCall) {
          if (!allowPropose) throw new AppError('forbidden');
          rawProposalCandidate = proposeCall.arguments;
        }

        if (rawProposalCandidate !== null) {
          try {
            let candidateToValidate = rawProposalCandidate;
            if (
              rawProposalCandidate &&
              typeof rawProposalCandidate === 'object' &&
              Array.isArray((rawProposalCandidate as { ops?: unknown }).ops)
            ) {
              const allOps = (rawProposalCandidate as { ops: unknown[] }).ops;
              if (allOps.length > this.deps.config.maxProposalOps) {
                const firstStageOps = allOps.slice(0, this.deps.config.maxProposalOps);
                const remainingCount = allOps.length - firstStageOps.length;
                candidateToValidate = {
                  ...(rawProposalCandidate as Record<string, unknown>),
                  ops: firstStageOps,
                  warnings: [
                    ...(((rawProposalCandidate as { warnings?: string[] }).warnings ?? [])),
                    `Plan dividido en etapas: ${firstStageOps.length} operaciones en esta etapa, ${remainingCount} pendientes.`,
                  ],
                };
                continuationPayload = {
                  kind: 'staged_ops',
                  remainingOpsCount: remainingCount,
                  baseVersion,
                };
              }
            }

            const prepared = prepareProposal(
              baseDoc,
              candidateToValidate,
              { entities: null },
              { maxOps: this.deps.config.maxProposalOps },
            );

            const currentRole = await getRole(this.deps.prisma, projectId, user);
            if (!currentRole || currentRole === 'viewer') throw new AppError('forbidden');

            const savedProposal = await this.deps.repo.saveProposal({
              conversationId,
              projectId,
              userId: user.id,
              generationId,
              requestedModel: model.id,
              reportedModel,
              baseDoc,
              afterDoc: prepared.after,
              ops: prepared.ops,
              baseVersion,
              baseHash,
              summary: prepared.summary,
              warnings: prepared.warnings,
              expiresAt: new Date(this.now().getTime() + PROPOSAL_TTL_MS),
            });
            createdProposalId = savedProposal.id;
            handle.publish({
              event: 'proposal',
              data: { proposalId: savedProposal.id, revision: savedProposal.revision },
            });
            break;
          } catch (err) {
            rawProposalCandidate = null;
            if (!repairUsed && rounds < this.deps.config.maxRounds) {
              repairUsed = true;
              if (proposeCall) {
                messages.push({
                  role: 'assistant',
                  content: roundText,
                  toolCalls: [proposeCall],
                });
              }
              messages.push({
                role: 'tool_result',
                toolCallId: proposeCall?.id,
                toolName: 'propose_changes',
                content:
                  'Error de validación semántica en la propuesta: verifica referencias, tipos del motor, nombres únicos y propiedades permitidas.',
              });
              continue;
            }
            throw err instanceof AppError ? err : new AppError('ai_invalid_proposal');
          }
        }

        const readCalls = toolCallsThisRound.filter((tc) => tc.name !== 'propose_changes');
        if (readCalls.length === 0) break;

        messages.push({
          role: 'assistant',
          content: roundText,
          toolCalls: readCalls,
        });

        for (const call of readCalls) {

          let pageResult;
          if (call.name === 'search_entities') {
            pageResult = queryContext(
              index,
              {
                part: 'catalog',
                query: typeof call.arguments.query === 'string' ? call.arguments.query : undefined,
                cursor:
                  typeof call.arguments.cursor === 'string' ? call.arguments.cursor : undefined,
                limit:
                  typeof call.arguments.limit === 'number'
                    ? call.arguments.limit
                    : this.deps.config.defaultPageSize,
              },
              contextBudget,
            );
          } else if (call.name === 'get_entity_details') {
            pageResult = queryContext(
              index,
              {
                part: 'detail',
                ids: parseScopeEntities(call.arguments.ids),
                cursor:
                  typeof call.arguments.cursor === 'string' ? call.arguments.cursor : undefined,
              },
              contextBudget,
            );
          } else if (call.name === 'get_entity_fields') {
            pageResult = queryContext(
              index,
              {
                part: 'fields',
                ids: [{ coll: 'tables', id: call.arguments.tableId as Id }],
                query: typeof call.arguments.query === 'string' ? call.arguments.query : undefined,
                cursor:
                  typeof call.arguments.cursor === 'string' ? call.arguments.cursor : undefined,
                limit:
                  typeof call.arguments.limit === 'number'
                    ? call.arguments.limit
                    : this.deps.config.defaultPageSize,
              },
              contextBudget,
            );
          } else {
            pageResult = queryContext(
              index,
              {
                part: 'neighbors',
                ids: parseScopeEntities(call.arguments.ids),
                direction:
                  call.arguments.direction === 'in' ||
                  call.arguments.direction === 'out' ||
                  call.arguments.direction === 'both'
                    ? call.arguments.direction
                    : 'both',
                cursor:
                  typeof call.arguments.cursor === 'string' ? call.arguments.cursor : undefined,
              },
              contextBudget,
            );
          }

          handle.publish({
            event: 'progress',
            data: {
              reviewed: pageResult.coverage.reviewed,
              remaining: pageResult.coverage.remaining,
              scope: pageResult.scope,
              baseVersion,
            },
          });

          continuationPayload = pageResult.nextCursor
            ? {
                kind: 'analysis',
                cursor: pageResult.nextCursor,
                baseVersion,
                baseHash,
                reviewed: pageResult.coverage.reviewed,
                remaining: pageResult.coverage.remaining,
              }
            : null;

          messages.push({
            role: 'tool_result',
            toolCallId: call.id,
            toolName: call.name,
            content: JSON.stringify({
              items: pageResult.items,
              nextCursor: pageResult.nextCursor,
              coverage: pageResult.coverage,
            }),
          });
        }
      }

      if (!accumulatedText.trim() && createdProposalId) {
        accumulatedText = 'Propuesta preparada para revisión.';
        handle.publish({ event: 'text', data: { delta: accumulatedText } });
      }

      const finalRole = await getRole(this.deps.prisma, projectId, user);
      if (!finalRole) throw new AppError('not_found');

      await this.deps.repo.completeGeneration({
        generationId,
        assistantMessageId,
        content: accumulatedText,
        reportedModel,
        usage: latestUsage,
        proposalId: createdProposalId,
        continuation: continuationPayload,
      });

      const encodedCont = continuationPayload ? encodeContinuation(continuationPayload) : null;
      handle.publish({
        event: 'done',
        data: {
          messageId: assistantMessageId,
          proposalId: createdProposalId,
          continuation: encodedCont,
        },
      });
    } catch (err) {
      try {
        if (handle.signal.aborted || (err instanceof Error && err.message === 'aborted')) {
          await this.deps.repo.failOrCancelGeneration({
            generationId,
            assistantMessageId,
            status: 'cancelled',
            partialContent: accumulatedText,
          });
        } else {
          const code = err instanceof AppError ? err.code : 'ai_unavailable';
          await this.deps.repo.failOrCancelGeneration({
            generationId,
            assistantMessageId,
            status: 'failed',
            errorCode: code,
            partialContent: accumulatedText,
          });
          handle.publish({ event: 'error', data: { code } });
        }
      } catch {
        // Conversation or project may have been deleted concurrently
      }
    } finally {
      handle.release();
    }
  }


  async get(projectId: string, generationId: string, user: PublicUser) {
    await this.requireProjectAccess(projectId, user);
    const row = await this.deps.prisma.aiGeneration.findFirst({
      where: { id: generationId, projectId, userId: user.id },
    });
    if (!row) throw new AppError('not_found');
    return {
      id: row.id,
      status: row.status,
      messageId: row.assistantMessageId,
      proposalId: row.proposalId,
      error: row.errorCode,
      continuation:
        row.continuation && typeof row.continuation === 'object'
          ? encodeContinuation(row.continuation as Record<string, unknown>)
          : null,
    };
  }

  async cancel(projectId: string, generationId: string, user: PublicUser): Promise<void> {
    await this.requireProjectAccess(projectId, user);
    const row = await this.deps.prisma.aiGeneration.findFirst({
      where: { id: generationId, projectId, userId: user.id },
      select: { id: true, status: true, assistantMessageId: true },
    });
    if (!row) throw new AppError('not_found');
    this.deps.registry.cancelGeneration(generationId);
    if (row.status === 'pending' || row.status === 'running') {
      await this.deps.repo.failOrCancelGeneration({
        generationId,
        assistantMessageId: row.assistantMessageId,
        status: 'cancelled',
      });
    }
  }

  async events(
    projectId: string,
    generationId: string,
    user: PublicUser,
    res: Response,
    lastEventIdRaw?: string,
  ): Promise<void> {
    await this.requireProjectAccess(projectId, user);
    const row = await this.deps.prisma.aiGeneration.findFirst({
      where: { id: generationId, projectId, userId: user.id },
      include: { assistantMessage: true, proposal: true },
    });
    if (!row) throw new AppError('not_found');

    const lastEventId =
      lastEventIdRaw && /^\d+$/.test(lastEventIdRaw.trim())
        ? Number.parseInt(lastEventIdRaw.trim(), 10)
        : 0;

    const entry = this.deps.registry.getEntry(generationId);
    if (lastEventId > 0) {
      if (entry) {
        const firstRetainedId = entry.events[0]?.id ?? entry.nextEventId;
        if (lastEventId < firstRetainedId - 1) {
          throw new AppError('ai_busy');
        }
      } else {
        throw new AppError('ai_busy');
      }
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const writeEnvelope = (env: SseEnvelope): boolean => {
      if (res.writableEnded || res.destroyed) return false;
      return res.write(
        `id: ${env.id}\nevent: ${env.event}\ndata: ${JSON.stringify(env.data)}\n\n`,
      );
    };

    if (entry) {
      for (const ev of entry.events) {
        if (ev.id > lastEventId) writeEnvelope(ev);
      }
      if (entry.terminal || entry.released || row.status === 'cancelled' || row.status === 'complete' || row.status === 'failed') {
        res.end();
        return;
      }


      await new Promise<void>((resolve) => {
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(': heartbeat\n\n');
          }
        }, 15_000);
        heartbeat.unref();

        const sub = {
          push: (env: SseEnvelope) => {
            if (env.id <= lastEventId) return true;
            return writeEnvelope(env);
          },
          close: () => {
            clearInterval(heartbeat);
            entry.subscribers.delete(sub);
            if (!res.writableEnded) res.end();
            resolve();
          },
        };
        entry.subscribers.add(sub);
        res.on('close', () => {
          clearInterval(heartbeat);
          entry.subscribers.delete(sub);
          resolve();
        });
      });
      return;
    }

    let seq = 1;
    const emitCanonical = (payload: SseEnvelope) => {
      if (payload.id > lastEventId) writeEnvelope(payload);
    };
    emitCanonical({
      id: seq++,
      event: 'generation',
      data: {
        generationId: row.id,
        messageId: row.assistantMessageId,
        requestedModel: row.requestedModel,
      },
    });
    if (row.assistantMessage.content) {
      emitCanonical({
        id: seq++,
        event: 'text',
        data: { delta: row.assistantMessage.content },
      });
    }
    if (row.proposal) {
      emitCanonical({
        id: seq++,
        event: 'proposal',
        data: { proposalId: row.proposal.id, revision: row.proposal.revision },
      });
    }
    if (row.status === 'complete') {
      emitCanonical({
        id: seq++,
        event: 'done',
        data: {
          messageId: row.assistantMessageId,
          proposalId: row.proposalId,
          continuation:
            row.continuation && typeof row.continuation === 'object'
              ? encodeContinuation(row.continuation as Record<string, unknown>)
              : null,
        },
      });
    } else if (row.status === 'failed') {
      emitCanonical({
        id: seq++,
        event: 'error',
        data: { code: row.errorCode ?? 'ai_unavailable' },
      });
    }
    res.end();
  }

  async getProposalDetail(
    projectId: string,
    proposalId: string,
    user: PublicUser,
  ): Promise<ProposalDetail> {
    await this.requireProjectAccess(projectId, user);
    const now = this.now();
    const row = await this.deps.prisma.aiProposal.findFirst({
      where: { id: proposalId, projectId, userId: user.id },
    });
    if (!row) throw new AppError('not_found');

    if (row.status === 'pending' && row.expiresAt.getTime() <= now.getTime()) {
      await this.deps.prisma.aiProposal.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'expired' },
      });
      row.status = 'expired';
    }

    const current = await this.deps.rooms.read(projectId);
    const stale =
      Number(row.baseVersion) !== current.version || row.baseHash !== current.baseHash;

    return {
      proposal: toProposalDto(row, now),
      before: row.baseDiagram as Document,
      after: row.afterDiagram as Document,
      stale,
    };
  }

  async discardProposal(
    projectId: string,
    proposalId: string,
    user: PublicUser,
  ): Promise<void> {
    const role = await this.requireProjectAccess(projectId, user);
    if (role === 'viewer') throw new AppError('forbidden');

    const row = await this.deps.prisma.aiProposal.findFirst({
      where: { id: proposalId, projectId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!row) throw new AppError('not_found');
    if (row.status === 'pending') {
      await this.deps.prisma.aiProposal.update({
        where: { id: row.id },
        data: { status: 'discarded' },
      });
    }
  }
}







