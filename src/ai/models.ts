import { createHash } from 'node:crypto';
import { AppError } from '../http/app-error';
import type { AiConfig } from './config';
import type { AiProvider, ModelCatalog, ModelChoice } from './types';

export type ModelCatalogServiceDeps = {
  provider: AiProvider;
  config: AiConfig;
  now?: () => number;
};

export type GetCatalogOptions = {
  refresh?: boolean;
  policyScope?: string;
  userId?: string;
  signal?: AbortSignal;
};

type CacheEntry = {
  catalog: ModelCatalog;
  fetchedAtMs: number;
};

const MAX_CACHE_SCOPES = 32;
const MAX_REFRESH_TRACKERS = 256;

export class ModelCatalogService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ModelCatalog>>();
  private readonly lastRefreshByUser = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ModelCatalogServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private buildCacheKey(policyScope = 'default'): string {
    const { baseUrl, apiKey, defaultModel, allowedModels, modelCapabilities } = this.deps.config;
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          baseUrl,
          apiKey,
          defaultModel,
          allowedModels,
          modelCapabilities,
          policyScope,
        }),
      )
      .digest('hex')
      .slice(0, 24);
    return `${policyScope}:${hash}`;
  }

  private canForceRefresh(userId: string | undefined, cacheKey: string, nowMs: number): boolean {
    const trackerKey = `${userId ?? 'anon'}:${cacheKey}`;
    const last = this.lastRefreshByUser.get(trackerKey);
    if (last !== undefined && nowMs - last < this.deps.config.catalogRefreshMinIntervalMs) {
      return false;
    }
    if (this.lastRefreshByUser.size >= MAX_REFRESH_TRACKERS) {
      const oldestKey = this.lastRefreshByUser.keys().next().value;
      if (oldestKey) this.lastRefreshByUser.delete(oldestKey);
    }
    this.lastRefreshByUser.set(trackerKey, nowMs);
    return true;
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  async get(opts: GetCatalogOptions = {}): Promise<ModelCatalog> {
    if (!this.deps.config.enabled) {
      throw new AppError('ai_disabled');
    }

    const nowMs = this.now();
    const cacheKey = this.buildCacheKey(opts.policyScope);
    const existing = this.cache.get(cacheKey);
    const isFresh =
      existing !== undefined && nowMs - existing.fetchedAtMs < this.deps.config.catalogTtlMs;

    const shouldRefresh =
      opts.refresh === true ? this.canForceRefresh(opts.userId, cacheKey, nowMs) : !isFresh;

    if (!shouldRefresh && existing) {
      return existing.catalog;
    }

    const pending = this.inflight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const fetchPromise = (async (): Promise<ModelCatalog> => {
      try {
        const fresh = await this.deps.provider.listModels(opts.signal);
        const normalized: ModelCatalog = {
          items: fresh.items,
          fetchedAt: fresh.fetchedAt ?? new Date(this.now()).toISOString(),
          stale: false,
          defaultModel: fresh.defaultModel,
        };
        if (this.cache.size >= MAX_CACHE_SCOPES && !this.cache.has(cacheKey)) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
        this.cache.set(cacheKey, { catalog: normalized, fetchedAtMs: this.now() });
        return normalized;
      } catch (err) {
        if (existing) {
          return {
            ...existing.catalog,
            stale: true,
          };
        }
        throw err instanceof AppError ? err : new AppError('ai_unavailable');
      } finally {
        this.inflight.delete(cacheKey);
      }
    })();

    this.inflight.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  async resolveModel(
    id: string,
    opts: { policyScope?: string; userId?: string; signal?: AbortSignal } = {},
  ): Promise<ModelChoice> {
    const trimmed = id.trim();
    if (!trimmed) {
      throw new AppError('ai_model_unavailable');
    }
    const catalog = await this.get({
      policyScope: opts.policyScope,
      userId: opts.userId,
      signal: opts.signal,
    });
    const found = catalog.items.find((item) => item.id === trimmed);
    if (!found || found.capabilities.chat !== true) {
      throw new AppError('ai_model_unavailable');
    }
    return found;
  }

  canPropose(model: ModelChoice): boolean {
    return model.capabilities.tools === true || model.capabilities.json === true;
  }
}
