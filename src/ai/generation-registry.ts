import { AppError } from '../http/app-error';
import type { AiConfig } from './config';
import type { Scope } from './types';

export type SseEventPayload =
  | {
      event: 'generation';
      data: { generationId: string; messageId: string; requestedModel: string };
    }
  | { event: 'text'; data: { delta: string } }
  | {
      event: 'progress';
      data: { reviewed: number; remaining: number; scope: Scope; baseVersion: number };
    }
  | { event: 'proposal'; data: { proposalId: string; revision: number } }
  | {
      event: 'done';
      data: { messageId: string; proposalId: string | null; continuation: string | null };
    }
  | { event: 'error'; data: { code: string } };

export type SseEnvelope = SseEventPayload & {
  id: number;
};

export type GenerationSubscriber = {
  push: (envelope: SseEnvelope) => boolean;
  close: () => void;
};

export type ActiveEntry = {
  generationId: string;
  conversationId: string;
  projectId: string;
  userId: string;
  messageId: string;
  requestedModel: string;
  controller: AbortController;
  events: SseEnvelope[];
  nextEventId: number;
  subscribers: Set<GenerationSubscriber>;
  terminal: boolean;
  released: boolean;
  finishedAtMs: number | null;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
};

const MAX_REPLAY_EVENTS = 256;
const MAX_FINISHED_RETENTION_MS = 5 * 60_000;
const MAX_FINISHED_ENTRIES = 64;
const RATE_WINDOW_MS = 60_000;

export class GenerationRegistry {
  private readonly entries = new Map<string, ActiveEntry>();
  private readonly activeByUser = new Map<string, Set<string>>();
  private activeGlobalCount = 0;
  private readonly userRequests = new Map<string, number[]>();
  private readonly projectRequests = new Map<string, number[]>();

  constructor(
    private readonly config: AiConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private pruneRateWindow(map: Map<string, number[]>, key: string, nowMs: number): number[] {
    const arr = map.get(key) ?? [];
    while (arr.length > 0 && nowMs - arr[0]! >= RATE_WINDOW_MS) {
      arr.shift();
    }
    if (arr.length === 0) map.delete(key);
    else map.set(key, arr);
    return arr;
  }

  private pruneFinishedEntries(nowMs: number): void {
    for (const [id, entry] of this.entries.entries()) {
      if (
        entry.released &&
        entry.finishedAtMs !== null &&
        nowMs - entry.finishedAtMs > MAX_FINISHED_RETENTION_MS
      ) {
        this.entries.delete(id);
      }
    }
    while (this.entries.size > MAX_FINISHED_ENTRIES) {
      const oldestFinished = [...this.entries.values()].find((e) => e.released);
      if (!oldestFinished) break;
      this.entries.delete(oldestFinished.generationId);
    }
  }

  acquire(input: {
    generationId: string;
    conversationId: string;
    projectId: string;
    userId: string;
    messageId: string;
    requestedModel: string;
  }) {
    const nowMs = this.now();
    this.pruneFinishedEntries(nowMs);

    const userActiveSet = this.activeByUser.get(input.userId);
    if ((userActiveSet?.size ?? 0) >= this.config.maxActivePerUser) {
      throw new AppError('ai_busy');
    }
    if (this.activeGlobalCount >= this.config.maxActiveGlobal) {
      throw new AppError('ai_busy');
    }

    const userTimestamps = this.pruneRateWindow(this.userRequests, input.userId, nowMs);
    if (userTimestamps.length >= this.config.maxRequestsPerMinutePerUser) {
      throw new AppError('ai_limit');
    }

    const projTimestamps = this.pruneRateWindow(this.projectRequests, input.projectId, nowMs);
    if (projTimestamps.length >= this.config.maxRequestsPerMinutePerProject) {
      throw new AppError('ai_limit');
    }

    userTimestamps.push(nowMs);
    this.userRequests.set(input.userId, userTimestamps);
    projTimestamps.push(nowMs);
    this.projectRequests.set(input.projectId, projTimestamps);

    const nextUserSet = userActiveSet ?? new Set<string>();
    nextUserSet.add(input.generationId);
    this.activeByUser.set(input.userId, nextUserSet);
    this.activeGlobalCount += 1;

    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const entry: ActiveEntry = {
      ...input,
      controller: new AbortController(),
      events: [],
      nextEventId: 1,
      subscribers: new Set(),
      terminal: false,
      released: false,
      finishedAtMs: null,
      completionPromise,
      resolveCompletion,
    };
    this.entries.set(input.generationId, entry);

    const publish = (payload: SseEventPayload): SseEnvelope | null => {
      if (entry.terminal) return null;
      if (payload.event === 'done' || payload.event === 'error') {
        entry.terminal = true;
      }
      const envelope: SseEnvelope = { id: entry.nextEventId++, ...payload };
      entry.events.push(envelope);
      if (entry.events.length > MAX_REPLAY_EVENTS) entry.events.shift();

      for (const sub of [...entry.subscribers]) {
        const ok = sub.push(envelope);
        if (!ok || entry.terminal) {
          entry.subscribers.delete(sub);
          sub.close();
        }
      }
      return envelope;
    };

    const release = (): void => {
      if (entry.released) return;
      entry.released = true;
      entry.finishedAtMs = this.now();
      const set = this.activeByUser.get(input.userId);
      if (set) {
        set.delete(input.generationId);
        if (set.size === 0) this.activeByUser.delete(input.userId);
      }
      this.activeGlobalCount = Math.max(0, this.activeGlobalCount - 1);
      for (const sub of [...entry.subscribers]) {
        sub.close();
      }
      entry.subscribers.clear();
      entry.resolveCompletion();
    };

    return {
      signal: entry.controller.signal,
      publish,
      release,
      abort: () => entry.controller.abort(),
    };
  }

  getEntry(generationId: string): ActiveEntry | undefined {
    return this.entries.get(generationId);
  }

  cancelGeneration(generationId: string): void {
    const entry = this.entries.get(generationId);
    if (!entry) return;
    entry.controller.abort();
    for (const sub of [...entry.subscribers]) {
      sub.close();
    }
    entry.subscribers.clear();
  }

  cancelByConversation(conversationId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.conversationId === conversationId && !entry.released) {
        this.cancelGeneration(entry.generationId);
      }
    }
  }

  cancelByProjectUser(projectId: string, userId?: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.projectId === projectId &&
        (userId === undefined || entry.userId === userId) &&
        !entry.released
      ) {
        this.cancelGeneration(entry.generationId);
      }
    }
  }

  shutdownAll(): void {
    for (const entry of this.entries.values()) {
      this.cancelGeneration(entry.generationId);
    }
  }
}

