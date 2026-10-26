import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../app';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../http/async-handler';
import { AppError } from '../http/app-error';
import { parse } from '../http/validate';
import { getRole } from '../projects/repo';
import { parseAiConfig, type AiConfig } from './config';
import { ConversationService } from './conversations';
import { AiGenerationService } from './generation';
import { GenerationRegistry } from './generation-registry';
import { ModelCatalogService } from './models';
import {
  createProjectSource,
  type AiRooms,
  type CommitProposalInput,
  type CommitProposalResult,
} from './project-source';
import { createAiProvider } from './provider';
import { AiRepository } from './repository';
import {
  applyProposalSchema,
  conversationIdParams,
  createConversationSchema,
  generationIdParams,
  modelsQuerySchema,
  paginationQuerySchema,
  projectIdParams,
  proposalIdParams,
  sendMessageSchema,
  updateConversationModelSchema,
} from './schemas';
import type { AiProvider } from './types';

export type AiRuntimeDeps = {
  config?: AiConfig;
  provider?: AiProvider;
  catalog?: ModelCatalogService;
  registry?: GenerationRegistry;
  rooms?: AiRooms;
  commitProposal?: (input: CommitProposalInput) => Promise<CommitProposalResult>;
  now?: () => Date;
};

function requireSameOrigin(appUrl: string) {
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(appUrl).origin;
  } catch {
    allowedOrigin = 'http://localhost:5173';
  }
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader.trim() !== '') {
      if (originHeader.trim() !== allowedOrigin) {
        next(new AppError('forbidden'));
        return;
      }
    }
    next();
  };
}

export function aiRouter(deps: AppDeps) {
  const { prisma, config } = deps;
  const aiConfig = deps.ai?.config ?? config.ai ?? parseAiConfig({});
  const provider = deps.ai?.provider ?? createAiProvider(aiConfig);
  const catalog =
    deps.ai?.catalog ??
    new ModelCatalogService({
      provider,
      config: aiConfig,
      now: deps.ai?.now ? () => deps.ai!.now!().getTime() : undefined,
    });
  const registry =
    deps.ai?.registry ??
    new GenerationRegistry(
      aiConfig,
      deps.ai?.now ? () => deps.ai!.now!().getTime() : undefined,
    );
  const repo = new AiRepository(prisma);

  const fallbackRooms: AiRooms =
    deps.ai?.rooms ??
    (deps.rooms && 'join' in deps.rooms
      ? createProjectSource(deps.rooms as unknown as import('../collab/rooms').RoomManager)
      : {
          async read(projectId: string) {
            if (deps.history) {
              const peeked = await deps.history.peekDoc(projectId);
              const { hashDocument } = await import('./document-index');
              const doc = peeked.doc as import('../collab/ops').Document;
              return { doc, version: peeked.version, epoch: 0, baseHash: hashDocument(doc) };
            }
            throw new AppError('ai_unavailable');
          },
        });

  const conversations = new ConversationService({
    prisma,
    repo,
    resolveModel: (id, opts) => catalog.resolveModel(id, opts),
    getDefaultModel: async (opts) => {
      const cat = await catalog.get(opts);
      return cat.defaultModel;
    },
    onCancelConversationGenerations: (cid) => registry.cancelByConversation(cid),
  });

  const generations = new AiGenerationService({
    prisma,
    config: aiConfig,
    provider,
    catalog,
    repo,
    registry,
    rooms: fallbackRooms,
    now: deps.ai?.now,
  });

  const commitProposalFn =
    deps.ai?.commitProposal ??
    (fallbackRooms.commitProposal
      ? (input: CommitProposalInput) => fallbackRooms.commitProposal!(input)
      : undefined);

  const router = express.Router({ mergeParams: true });
  router.use(requireAuth(prisma));
  router.use(requireSameOrigin(config.appUrl));

  router.use((req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      const { id } = parse(projectIdParams, req.params);
      const role = await getRole(prisma, id, req.user!);
      if (!role) throw new AppError('not_found');
      if (!aiConfig.enabled) throw new AppError('ai_disabled');
      next();
    })().catch(next);
  });


  router.get(
    '/models',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectIdParams, req.params);
      const query = parse(modelsQuerySchema, req.query);
      const refresh = query.refresh === '1' || query.refresh === 'true';
      res.json(
        await catalog.get({
          refresh,
          policyScope: `project:${id}`,
          userId: req.user!.id,
        }),
      );
    }),
  );

  router.get(
    '/conversations',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectIdParams, req.params);
      const query = parse(paginationQuerySchema, req.query);
      res.json(await conversations.list(id, req.user!, query));
    }),
  );

  router.post(
    '/conversations',
    asyncHandler(async (req, res) => {
      const { id } = parse(projectIdParams, req.params);
      const body = parse(createConversationSchema, req.body ?? {});
      res.status(201).json(await conversations.create(id, req.user!, body));
    }),
  );

  router.patch(
    '/conversations/:cid',
    asyncHandler(async (req, res) => {
      const { id, cid } = parse(conversationIdParams, req.params);
      const body = parse(updateConversationModelSchema, req.body);
      res.json(await conversations.setModel(id, cid, req.user!, body));
    }),
  );

  router.delete(
    '/conversations/:cid',
    asyncHandler(async (req, res) => {
      const { id, cid } = parse(conversationIdParams, req.params);
      await conversations.remove(id, cid, req.user!);
      res.status(204).end();
    }),
  );

  router.get(
    '/conversations/:cid/messages',
    asyncHandler(async (req, res) => {
      const { id, cid } = parse(conversationIdParams, req.params);
      const query = parse(paginationQuerySchema, req.query);
      res.json(await conversations.getMessages(id, cid, req.user!, query));
    }),
  );

  router.post(
    '/conversations/:cid/messages',
    asyncHandler(async (req, res) => {
      const { id, cid } = parse(conversationIdParams, req.params);
      const body = parse(sendMessageSchema, req.body);
      const result = await generations.start(id, cid, req.user!, body);
      res.status(202).json(result);
    }),
  );

  router.get(
    '/generations/:gid',
    asyncHandler(async (req, res) => {
      const { id, gid } = parse(generationIdParams, req.params);
      res.json(await generations.get(id, gid, req.user!));
    }),
  );

  router.get(
    '/generations/:gid/events',
    asyncHandler(async (req, res) => {
      const { id, gid } = parse(generationIdParams, req.params);
      const lastEventId =
        typeof req.headers['last-event-id'] === 'string'
          ? req.headers['last-event-id']
          : undefined;
      await generations.events(id, gid, req.user!, res, lastEventId);
    }),
  );

  router.post(
    '/generations/:gid/cancel',
    asyncHandler(async (req, res) => {
      const { id, gid } = parse(generationIdParams, req.params);
      await generations.cancel(id, gid, req.user!);
      res.status(204).end();
    }),
  );

  router.get(
    '/proposals/:pid',
    asyncHandler(async (req, res) => {
      const { id, pid } = parse(proposalIdParams, req.params);
      res.json(await generations.getProposalDetail(id, pid, req.user!));
    }),
  );

  router.post(
    '/proposals/:pid/apply',
    asyncHandler(async (req, res) => {
      const { id, pid } = parse(proposalIdParams, req.params);
      const { revision } = parse(applyProposalSchema, req.body);
      if (!commitProposalFn) {
        throw new AppError('ai_unavailable');
      }
      const applied = await commitProposalFn({
        projectId: id,
        proposalId: pid,
        revision,
        user: req.user!,
      });
      res.json(applied);
    }),
  );

  router.post(
    '/proposals/:pid/discard',
    asyncHandler(async (req, res) => {
      const { id, pid } = parse(proposalIdParams, req.params);
      await generations.discardProposal(id, pid, req.user!);
      res.status(204).end();
    }),
  );

  return router;
}

