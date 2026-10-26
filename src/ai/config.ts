export type AiModelCapabilityOverride = {
  chat?: boolean | null;
  tools?: boolean | null;
  json?: boolean | null;
  stream?: boolean | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  provider?: string | null;
  label?: string;
};

export type AiConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  defaultModel: string | null;
  allowedModels: string[] | null;
  modelCapabilities: Record<string, AiModelCapabilityOverride>;
  catalogTtlMs: number;
  catalogRefreshMinIntervalMs: number;
  catalogTimeoutMs: number;
  generationTimeoutMs: number;
  maxCatalogBytes: number;
  maxResponseBytes: number;
  maxContextBytesPerCall: number;
  maxMessageChars: number;
  maxRecentMessages: number;
  maxRounds: number;
  maxProposalOps: number;
  defaultPageSize: number;
  conservativeContextWindow: number;
  conservativeMaxOutputTokens: number;
  maxActivePerUser: number;
  maxActiveGlobal: number;
  maxRequestsPerMinutePerUser: number;
  maxRequestsPerMinutePerProject: number;
};

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const cleaned = stripQuotes(raw);
  if (!cleaned) return fallback;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCapabilitiesMap(raw: string | undefined): Record<string, AiModelCapabilityOverride> {
  if (!raw || !raw.trim()) return {};
  const cleaned = stripQuotes(raw);
  if (!cleaned) return {};
  try {
    let parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AiModelCapabilityOverride> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      const v = val as Record<string, unknown>;
      out[key] = {
        chat: typeof v.chat === 'boolean' ? v.chat : v.chat === null ? null : undefined,
        tools: typeof v.tools === 'boolean' ? v.tools : v.tools === null ? null : undefined,
        json: typeof v.json === 'boolean' ? v.json : v.json === null ? null : undefined,
        stream: typeof v.stream === 'boolean' ? v.stream : v.stream === null ? null : undefined,
        contextWindow:
          typeof v.contextWindow === 'number' && Number.isFinite(v.contextWindow)
            ? v.contextWindow
            : null,
        maxOutputTokens:
          typeof v.maxOutputTokens === 'number' && Number.isFinite(v.maxOutputTokens)
            ? v.maxOutputTokens
            : null,
        provider: typeof v.provider === 'string' ? v.provider : undefined,
        label: typeof v.label === 'string' ? v.label : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function normalizeLitellmV1Url(rawBaseUrl: string): string {
  let trimmed = stripQuotes(rawBaseUrl).replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

export function parseAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const baseUrl = normalizeLitellmV1Url(env.LITELLM_BASE_URL || '');
  const apiKey = stripQuotes(env.LITELLM_API_KEY || '');
  const enabledFlag = stripQuotes(env.AI_ENABLED || '').toLowerCase();
  const enabled = (enabledFlag === 'true' || enabledFlag === '1') && Boolean(baseUrl && apiKey);
  const defaultModel = stripQuotes(env.LITELLM_MODEL || '') || null;
  const allowedList = stripQuotes(env.AI_ALLOWED_MODELS || '')
    .split(',')
    .map((m) => stripQuotes(m))
    .filter(Boolean);

  return {
    enabled,
    baseUrl,
    apiKey,
    defaultModel,
    allowedModels: allowedList.length > 0 ? allowedList : null,
    modelCapabilities: parseCapabilitiesMap(env.AI_MODEL_CAPABILITIES),
    catalogTtlMs: parsePositiveInt(env.AI_CATALOG_TTL_MS, 60_000),
    catalogRefreshMinIntervalMs: parsePositiveInt(env.AI_CATALOG_REFRESH_MIN_MS, 10_000),
    catalogTimeoutMs: parsePositiveInt(env.AI_CATALOG_TIMEOUT_MS, 10_000),
    generationTimeoutMs: parsePositiveInt(env.AI_GENERATION_TIMEOUT_MS, 60_000),
    maxCatalogBytes: parsePositiveInt(env.AI_MAX_CATALOG_BYTES, 2 * 1024 * 1024),
    maxResponseBytes: parsePositiveInt(env.AI_MAX_RESPONSE_BYTES, 1 * 1024 * 1024),
    maxContextBytesPerCall: parsePositiveInt(env.AI_MAX_CONTEXT_BYTES, 200 * 1024),
    maxMessageChars: parsePositiveInt(env.AI_MAX_MESSAGE_CHARS, 8_000),
    maxRecentMessages: parsePositiveInt(env.AI_MAX_RECENT_MESSAGES, 20),
    maxRounds: parsePositiveInt(env.AI_MAX_ROUNDS, 12),
    maxProposalOps: parsePositiveInt(env.AI_MAX_PROPOSAL_OPS, 500),
    defaultPageSize: parsePositiveInt(env.AI_DEFAULT_PAGE_SIZE, 25),
    conservativeContextWindow: parsePositiveInt(env.AI_CONSERVATIVE_CONTEXT_WINDOW, 16_384),
    conservativeMaxOutputTokens: parsePositiveInt(env.AI_CONSERVATIVE_MAX_OUTPUT_TOKENS, 2_048),
    maxActivePerUser: parsePositiveInt(env.AI_MAX_ACTIVE_PER_USER, 1),
    maxActiveGlobal: parsePositiveInt(env.AI_MAX_ACTIVE_GLOBAL, 4),
    maxRequestsPerMinutePerUser: parsePositiveInt(env.AI_RATE_LIMIT_USER_PER_MIN, 10),
    maxRequestsPerMinutePerProject: parsePositiveInt(env.AI_RATE_LIMIT_PROJECT_PER_MIN, 30),
  };
}
