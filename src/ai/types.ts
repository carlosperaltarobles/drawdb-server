import type { Coll, Document, Id, Op } from '../collab/ops';

export type { Coll, Document, Id, Op };

export type ModelCapabilities = {
  chat: boolean | null;
  tools: boolean | null;
  json: boolean | null;
  stream: boolean | null;
};

export type ModelChoice = {
  id: string;
  label: string;
  provider: string | null;
  capabilities: ModelCapabilities;
  contextWindow: number | null;
  maxOutputTokens: number | null;
};

export type ModelCatalog = {
  items: ModelChoice[];
  fetchedAt: string | null;
  stale: boolean;
  defaultModel: string | null;
};

export type Conversation = {
  id: string;
  projectId: string;
  selectedModel: string | null;
  title: string | null;
  updatedAt: string;
  activeGenerationId: string | null;
};

export type MessageStatus = 'pending' | 'complete' | 'failed' | 'cancelled';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  requestedModel: string | null;
  reportedModel: string | null;
  usage: Record<string, unknown> | null;
  createdAt: string;
};

export type ProposalStatus = 'pending' | 'superseded' | 'discarded' | 'applied' | 'expired';

export type ChangeSummaryItem = {
  coll: Coll;
  id: Id;
  parentId?: Id;
  change: 'added' | 'modified' | 'removed';
  beforeName?: string;
  afterName?: string;
  properties: string[];
};

export type ChangeSummary = {
  counts: {
    added: number;
    modified: number;
    removed: number;
  };
  items: ChangeSummaryItem[];
};

export type Proposal = {
  id: string;
  revision: number;
  conversationId: string;
  requestedModel: string;
  reportedModel: string | null;
  baseVersion: number;
  baseHash: string;
  status: ProposalStatus;
  summary: ChangeSummary;
  warnings: string[];
  expiresAt: string;
  appliedVersion: number | null;
  snapshotId: string | null;
};

export type ProposalDetail = {
  proposal: Proposal;
  before: Document;
  after: Document;
  stale: boolean;
};

export type ScopeEntity = {
  coll: Coll;
  id: Id;
};

export type Scope = {
  entities: ScopeEntity[] | null;
};

export type ContextPage = {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  scope: Scope;
  baseVersion: number;
  baseHash: string;
  coverage: {
    reviewed: number;
    remaining: number;
  };
  bytes: number;
};

export type CanonicalToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type CanonicalMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: CanonicalToolCall[] }
  | { role: 'tool_result'; toolCallId?: string; toolName: string; content: string };


export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProviderInput = {
  model: ModelChoice;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  mode: 'tools' | 'json' | 'text';
  maxOutputTokens: number;
};

export type ProviderUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done'; reportedModel: string | null; finishReason: string | null };

export interface AiProvider {
  listModels(signal?: AbortSignal): Promise<ModelCatalog>;
  generate(input: ProviderInput, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}
