import type { PrismaClient } from '../db/prisma';
import type { Prisma } from '../generated/prisma/client';
import { AppError } from '../http/app-error';
import type {
  ChangeSummary,
  Conversation,
  Document,
  Message,
  Op,
  Proposal,
  ProposalStatus,
} from './types';

export const PROPOSAL_TTL_MS = 24 * 3600_000;

export function toConversationDto(row: {
  id: string;
  projectId: string;
  selectedModel: string | null;
  title: string | null;
  updatedAt: Date;
  generations?: Array<{ id: string }>;
}): Conversation {
  return {
    id: row.id,
    projectId: row.projectId,
    selectedModel: row.selectedModel,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    activeGenerationId: row.generations?.[0]?.id ?? null,
  };
}

export function toMessageDto(row: {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'complete' | 'failed' | 'cancelled';
  requestedModel: string | null;
  reportedModel: string | null;
  usage: unknown;
  createdAt: Date;
}): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    requestedModel: row.requestedModel,
    reportedModel: row.reportedModel,
    usage:
      row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage)
        ? (row.usage as Record<string, unknown>)
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toProposalDto(
  row: {
    id: string;
    revision: number;
    conversationId: string;
    requestedModel: string;
    reportedModel: string | null;
    baseVersion: bigint;
    baseHash: string;
    status: ProposalStatus;
    summary: unknown;
    warnings: unknown;
    expiresAt: Date;
    appliedVersion: bigint | null;
    snapshotId: string | null;
    appliedResult?: unknown;
  },
  now = new Date(),
): Proposal {
  let effectiveStatus: ProposalStatus = row.status;
  if (effectiveStatus === 'pending' && row.expiresAt.getTime() <= now.getTime()) {
    effectiveStatus = 'expired';
  }
  const appliedSnapId =
    row.snapshotId ??
    (row.appliedResult &&
    typeof row.appliedResult === 'object' &&
    !Array.isArray(row.appliedResult) &&
    typeof (row.appliedResult as { snapshotId?: unknown }).snapshotId === 'string'
      ? ((row.appliedResult as { snapshotId: string }).snapshotId ?? null)
      : null);

  return {
    id: row.id,
    revision: row.revision,
    conversationId: row.conversationId,
    requestedModel: row.requestedModel,
    reportedModel: row.reportedModel,
    baseVersion: Number(row.baseVersion),
    baseHash: row.baseHash,
    status: effectiveStatus,
    summary: (row.summary as ChangeSummary) ?? {
      counts: { added: 0, modified: 0, removed: 0 },
      items: [],
    },
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter((w): w is string => typeof w === 'string')
      : [],
    expiresAt: row.expiresAt.toISOString(),
    appliedVersion: row.appliedVersion !== null ? Number(row.appliedVersion) : null,
    snapshotId: appliedSnapId,
  };
}

export class AiRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listConversations(
    projectId: string,
    userId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 50));
    const rows = await this.prisma.aiConversation.findMany({
      where: { projectId, userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        generations: {
          where: { status: { in: ['pending', 'running'] } },
          select: { id: true },
          take: 1,
        },
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toConversationDto);
    const nextCursor = hasMore ? items[items.length - 1]!.id : null;
    return { items, nextCursor };
  }

  async getConversationOwned(
    projectId: string,
    conversationId: string,
    userId: string,
  ): Promise<Conversation> {
    const row = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, projectId, userId },
      include: {
        generations: {
          where: { status: { in: ['pending', 'running'] } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!row) throw new AppError('not_found');
    return toConversationDto(row);
  }

  async createConversation(input: {
    projectId: string;
    userId: string;
    selectedModel: string | null;
    title?: string | null;
  }): Promise<Conversation> {
    const row = await this.prisma.aiConversation.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        selectedModel: input.selectedModel,
        title: input.title ?? null,
      },
    });
    return toConversationDto(row);
  }

  async updateConversationModel(
    projectId: string,
    conversationId: string,
    userId: string,
    selectedModel: string,
  ): Promise<Conversation> {
    return this.prisma.$transaction(async (tx) => {
      const conv = await tx.aiConversation.findFirst({
        where: { id: conversationId, projectId, userId },
        include: {
          generations: {
            where: { status: { in: ['pending', 'running'] } },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!conv) throw new AppError('not_found');
      if (conv.generations.length > 0) {
        throw new AppError('ai_busy');
      }
      const updated = await tx.aiConversation.update({
        where: { id: conv.id },
        data: { selectedModel },
        include: {
          generations: {
            where: { status: { in: ['pending', 'running'] } },
            select: { id: true },
            take: 1,
          },
        },
      });
      return toConversationDto(updated);
    });
  }

  async deleteConversation(
    projectId: string,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const { count } = await this.prisma.aiConversation.deleteMany({
      where: { id: conversationId, projectId, userId },
    });
    if (count === 0) throw new AppError('not_found');
  }

  async listMessagesAndProposals(
    projectId: string,
    conversationId: string,
    userId: string,
    opts: { cursor?: string; limit?: number; now?: Date } = {},
  ): Promise<{ items: Message[]; proposals: Proposal[]; nextCursor: string | null }> {
    const conv = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, projectId, userId },
      select: { id: true },
    });
    if (!conv) throw new AppError('not_found');

    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 50));

    // Expire overdue pending proposals in this conversation on read
    await this.prisma.aiProposal.updateMany({
      where: {
        conversationId,
        status: 'pending',
        expiresAt: { lte: now },
      },
      data: { status: 'expired' },
    });

    const [msgRows, proposalRows] = await Promise.all([
      this.prisma.aiMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      }),
      this.prisma.aiProposal.findMany({
        where: { conversationId, projectId, userId },
        orderBy: [{ revision: 'desc' }],
      }),
    ]);

    const hasMore = msgRows.length > limit;
    const page = hasMore ? msgRows.slice(0, limit) : msgRows;
    const items = page.map(toMessageDto);
    const proposals = proposalRows.map((p) => toProposalDto(p, now));
    const nextCursor = hasMore ? items[items.length - 1]!.id : null;
    return { items, proposals, nextCursor };
  }

  async findGenerationByRequestId(input: {
    conversationId: string;
    projectId: string;
    userId: string;
    requestId: string;
  }) {
    return this.prisma.aiGeneration.findFirst({
      where: {
        conversationId: input.conversationId,
        projectId: input.projectId,
        userId: input.userId,
        requestId: input.requestId,
      },
    });
  }

  async createGenerationTurn(input: {
    conversationId: string;
    projectId: string;
    userId: string;
    requestId: string;
    userContent: string;
    requestedModel: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const conv = await tx.aiConversation.findFirst({
        where: {
          id: input.conversationId,
          projectId: input.projectId,
          userId: input.userId,
        },
        include: {
          generations: {
            where: { status: { in: ['pending', 'running'] } },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!conv) throw new AppError('not_found');

      const existing = await tx.aiGeneration.findUnique({
        where: {
          conversationId_userId_requestId: {
            conversationId: input.conversationId,
            userId: input.userId,
            requestId: input.requestId,
          },
        },
        include: { assistantMessage: true },
      });
      if (existing) {
        return {
          alreadyExists: true as const,
          generation: existing,
          userMessage: toMessageDto(existing.assistantMessage),
          assistantMessage: toMessageDto(existing.assistantMessage),
        };
      }

      if (conv.generations.length > 0) {
        throw new AppError('ai_busy');
      }

      const activeUserGen = await tx.aiGeneration.count({
        where: {
          userId: input.userId,
          status: { in: ['pending', 'running'] },
        },
      });
      if (activeUserGen > 0) {
        throw new AppError('ai_busy');
      }

      const title = conv.title ?? (input.userContent.trim().slice(0, 80) || 'Conversación');

      const userMessage = await tx.aiMessage.create({
        data: {
          conversationId: input.conversationId,
          role: 'user',
          content: input.userContent,
          status: 'complete',
          requestedModel: input.requestedModel,
        },
      });

      const assistantMessage = await tx.aiMessage.create({
        data: {
          conversationId: input.conversationId,
          role: 'assistant',
          content: '',
          status: 'pending',
          requestedModel: input.requestedModel,
        },
      });

      const generation = await tx.aiGeneration.create({
        data: {
          conversationId: input.conversationId,
          projectId: input.projectId,
          userId: input.userId,
          requestId: input.requestId,
          status: 'running',
          requestedModel: input.requestedModel,
          assistantMessageId: assistantMessage.id,
        },
      });

      await tx.aiConversation.update({
        where: { id: input.conversationId },
        data: { title, updatedAt: new Date() },
      });

      return {
        alreadyExists: false as const,
        generation,
        userMessage: toMessageDto(userMessage),
        assistantMessage: toMessageDto(assistantMessage),
      };
    });
  }

  async saveProposal(input: {
    conversationId: string;
    projectId: string;
    userId: string;
    generationId?: string;
    requestedModel: string;
    reportedModel: string | null;
    baseDoc: Document;
    afterDoc: Document;
    ops: Op[];
    baseVersion: number;
    baseHash: string;
    summary: ChangeSummary;
    warnings: string[];
    expiresAt: Date;
  }): Promise<Proposal> {
    return this.prisma.$transaction(async (tx) => {
      await tx.aiProposal.updateMany({
        where: {
          conversationId: input.conversationId,
          status: 'pending',
        },
        data: { status: 'superseded' },
      });

      const latest = await tx.aiProposal.findFirst({
        where: { conversationId: input.conversationId },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      const nextRevision = (latest?.revision ?? 0) + 1;

      const created = await tx.aiProposal.create({
        data: {
          conversationId: input.conversationId,
          projectId: input.projectId,
          userId: input.userId,
          revision: nextRevision,
          requestedModel: input.requestedModel,
          reportedModel: input.reportedModel,
          baseDiagram: input.baseDoc as Prisma.InputJsonValue,
          afterDiagram: input.afterDoc as Prisma.InputJsonValue,
          ops: input.ops as unknown as Prisma.InputJsonValue,
          baseVersion: BigInt(input.baseVersion),
          baseHash: input.baseHash,
          status: 'pending',
          summary: input.summary as unknown as Prisma.InputJsonValue,
          warnings: input.warnings as unknown as Prisma.InputJsonValue,
          expiresAt: input.expiresAt,
        },
      });

      if (input.generationId) {
        await tx.aiGeneration.updateMany({
          where: { id: input.generationId },
          data: { proposalId: created.id },
        });
      }

      return toProposalDto(created);
    });
  }

  async completeGeneration(input: {
    generationId: string;
    assistantMessageId: string;
    content: string;
    reportedModel: string | null;
    usage: Record<string, unknown> | null;
    proposalId: string | null;
    continuation?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const gen = await tx.aiGeneration.findUnique({
        where: { id: input.generationId },
        select: { status: true, conversationId: true },
      });
      if (!gen || gen.status === 'cancelled') return;

      await tx.aiMessage.updateMany({
        where: { id: input.assistantMessageId },
        data: {
          content: input.content,
          status: 'complete',
          reportedModel: input.reportedModel,
          ...(input.usage ? { usage: input.usage as Prisma.InputJsonValue } : {}),
        },
      });

      await tx.aiGeneration.updateMany({
        where: { id: input.generationId },
        data: {
          status: 'complete',
          reportedModel: input.reportedModel,
          proposalId: input.proposalId,
          ...(input.continuation !== undefined
            ? {
                continuation: input.continuation
                  ? (input.continuation as Prisma.InputJsonValue)
                  : undefined,
              }
            : {}),
        },
      });

      await tx.aiConversation.updateMany({
        where: { id: gen.conversationId },
        data: { updatedAt: new Date() },
      });
    });
  }

  async failOrCancelGeneration(input: {
    generationId: string;
    assistantMessageId?: string;
    status: 'failed' | 'cancelled';
    errorCode?: string | null;
    partialContent?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const gen = await tx.aiGeneration.findUnique({
        where: { id: input.generationId },
        select: { status: true, assistantMessageId: true },
      });
      if (!gen || gen.status === 'complete' || gen.status === 'cancelled') return;

      const msgId = input.assistantMessageId ?? gen.assistantMessageId;
      await tx.aiMessage.updateMany({
        where: { id: msgId },
        data: {
          status: input.status,
          ...(input.partialContent !== undefined ? { content: input.partialContent } : {}),
        },
      });

      await tx.aiGeneration.updateMany({
        where: { id: input.generationId },
        data: {
          status: input.status,
          errorCode: input.errorCode ?? null,
        },
      });
    });
  }

}



