import type { PublicUser } from '../auth/public-user';
import type { PrismaClient } from '../db/prisma';
import { AppError } from '../http/app-error';
import { getRole, type AccessRole } from '../projects/repo';
import type { AiRepository } from './repository';
import type { Conversation, Message, ModelChoice, Proposal } from './types';

export type ConversationServiceDeps = {
  prisma: PrismaClient;
  repo: AiRepository;
  resolveModel: (id: string, opts?: { userId?: string }) => Promise<ModelChoice>;
  getDefaultModel: (opts?: { userId?: string }) => Promise<string | null>;
  onCancelConversationGenerations?: (conversationId: string) => void;
};

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async requireAccess(projectId: string, user: PublicUser): Promise<AccessRole> {
    const role = await getRole(this.deps.prisma, projectId, user);
    if (!role) throw new AppError('not_found');
    return role;
  }

  async list(
    projectId: string,
    user: PublicUser,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    await this.requireAccess(projectId, user);
    return this.deps.repo.listConversations(projectId, user.id, opts);
  }

  async create(
    projectId: string,
    user: PublicUser,
    input: { selectedModel?: string },
  ): Promise<Conversation> {
    await this.requireAccess(projectId, user);
    let modelId: string | null = null;
    if (input.selectedModel !== undefined && input.selectedModel.trim()) {
      const resolved = await this.deps.resolveModel(input.selectedModel.trim(), { userId: user.id });
      modelId = resolved.id;
    } else {
      modelId = await this.deps.getDefaultModel({ userId: user.id });
    }
    return this.deps.repo.createConversation({
      projectId,
      userId: user.id,
      selectedModel: modelId,
    });
  }

  async setModel(
    projectId: string,
    conversationId: string,
    user: PublicUser,
    input: { selectedModel: string },
  ): Promise<Conversation> {
    await this.requireAccess(projectId, user);
    const resolved = await this.deps.resolveModel(input.selectedModel, { userId: user.id });
    return this.deps.repo.updateConversationModel(
      projectId,
      conversationId,
      user.id,
      resolved.id,
    );
  }

  async getMessages(
    projectId: string,
    conversationId: string,
    user: PublicUser,
    opts: { cursor?: string; limit?: number; now?: Date } = {},
  ): Promise<{ items: Message[]; proposals: Proposal[]; nextCursor: string | null }> {
    await this.requireAccess(projectId, user);
    return this.deps.repo.listMessagesAndProposals(projectId, conversationId, user.id, opts);
  }

  async remove(projectId: string, conversationId: string, user: PublicUser): Promise<void> {
    await this.requireAccess(projectId, user);
    await this.deps.repo.getConversationOwned(projectId, conversationId, user.id);
    this.deps.onCancelConversationGenerations?.(conversationId);
    await this.deps.repo.deleteConversation(projectId, conversationId, user.id);
  }
}
