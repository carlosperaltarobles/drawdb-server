import { AppError } from '../http/app-error';
import { normalizeLitellmV1Url, type AiConfig } from './config';
import { parseSseStream } from './sse';
import type {
  AiProvider,
  CanonicalMessage,
  ModelCatalog,
  ModelChoice,
  ProviderEvent,
  ProviderInput,
} from './types';

const NON_CHAT_MODES = new Set([
  'embedding',
  'image_generation',
  'audio_transcription',
  'audio_speech',
  'moderation',
  'rerank',
  'completion',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new AppError('ai_unavailable');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  try {
    while (true) {
      if (signal?.aborted) throw new AppError('ai_unavailable');
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new AppError('ai_unavailable');
        }
        out += decoder.decode(value, { stream: true });
      }
    }
    out += decoder.decode();
    return out;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function mapUpstreamStatusToError(status: number, bodyText: string): AppError {
  if (status === 404) return new AppError('ai_model_unavailable');
  if (status === 429) return new AppError('ai_limit');
  if (status === 400 || status === 422) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: string; type?: string } };
      const code = parsed?.error?.code || parsed?.error?.type || '';
      if (code.includes('model') || code.includes('not_found')) {
        return new AppError('ai_model_unavailable');
      }
    } catch {
      // ignore parse failure
    }
    return new AppError('ai_unsupported');
  }
  return new AppError('ai_unavailable');
}

function toWireMessages(
  messages: CanonicalMessage[],
  mode: 'tools' | 'json' | 'text',
): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && mode === 'tools' && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content ? msg.content : null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    if (msg.role === 'tool_result') {
      if (mode === 'tools' && msg.toolCallId) {
        return {
          role: 'tool',
          tool_call_id: msg.toolCallId,
          name: msg.toolName,
          content: msg.content,
        };
      }
      return {
        role: 'user',
        content: `[Tool result: ${msg.toolName}]\n${msg.content}`,
      };
    }
    return {
      role: msg.role,
      content: msg.content,
    };
  });
}

function readPositiveNumber(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return c;
    }
  }
  return null;
}

function readBoolean(...candidates: unknown[]): boolean | null {
  for (const c of candidates) {
    if (typeof c === 'boolean') {
      return c;
    }
  }
  return null;
}

function toModelChoice(
  raw: unknown,
  enrichedInfo: Record<string, unknown> | undefined,
  config: AiConfig,
): ModelChoice | null {
  if (!isPlainRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 200) return null;

  if (config.allowedModels && !config.allowedModels.includes(id)) {
    return null;
  }

  const inlineInfo = isPlainRecord(raw.model_info) ? raw.model_info : null;
  const rawMode =
    typeof enrichedInfo?.mode === 'string'
      ? enrichedInfo.mode
      : typeof inlineInfo?.mode === 'string'
        ? inlineInfo.mode
        : typeof raw.mode === 'string'
          ? raw.mode
          : null;
  const mode = rawMode ? rawMode.trim().toLowerCase() : null;
  if (mode && NON_CHAT_MODES.has(mode)) {
    return null;
  }

  const override = config.modelCapabilities[id];
  // Unknown mode (null) must NOT imply verified chat; requires explicit mode === 'chat' or override.chat === true
  const chatCap =
    override?.chat !== undefined ? override.chat : mode === 'chat' ? true : null;

  if (chatCap !== true) {
    return null;
  }

  const toolsCap =
    override?.tools !== undefined
      ? override.tools
      : readBoolean(
          enrichedInfo?.supports_function_calling,
          inlineInfo?.supports_function_calling,
          raw.supports_function_calling,
        );
  const jsonCap =
    override?.json !== undefined
      ? override.json
      : readBoolean(
          enrichedInfo?.supports_response_schema,
          inlineInfo?.supports_response_schema,
          raw.supports_response_schema,
        );
  const streamCap =
    override?.stream !== undefined
      ? override.stream
      : readBoolean(
          enrichedInfo?.supports_native_streaming,
          inlineInfo?.supports_native_streaming,
          raw.supports_native_streaming,
        );

  const contextWindow =
    override?.contextWindow !== undefined
      ? override.contextWindow
      : readPositiveNumber(
          enrichedInfo?.max_input_tokens,
          inlineInfo?.max_input_tokens,
          raw.max_input_tokens,
        );

  const maxOutputTokens =
    override?.maxOutputTokens !== undefined
      ? override.maxOutputTokens
      : readPositiveNumber(
          enrichedInfo?.max_output_tokens,
          inlineInfo?.max_output_tokens,
          raw.max_output_tokens,
        );

  const provider =
    override?.provider !== undefined
      ? override.provider
      : typeof raw.owned_by === 'string' && raw.owned_by.trim()
        ? raw.owned_by.trim().slice(0, 64)
        : null;

  const label = override?.label?.trim() || id;

  return {
    id,
    label,
    provider,
    capabilities: {
      chat: true,
      tools: toolsCap,
      json: jsonCap,
      stream: streamCap,
    },
    contextWindow,
    maxOutputTokens,
  };
}


export function createAiProvider(config: AiConfig, fetcher: typeof fetch = fetch): AiProvider {
  const v1Base = normalizeLitellmV1Url(config.baseUrl);

  const ensureConfigured = () => {
    if (!config.enabled || !v1Base || !config.apiKey) {
      throw new AppError('ai_disabled');
    }
  };

  return {
    async listModels(signal?: AbortSignal): Promise<ModelCatalog> {
      ensureConfigured();
      const timeoutSignal = AbortSignal.timeout(config.catalogTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let response: Response;
      try {
        response = await fetcher(`${v1Base}/models`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: 'application/json',
          },
          signal: combinedSignal,
        });
      } catch {
        throw new AppError('ai_unavailable');
      }

      const rawText = await readBoundedBytes(response, config.maxCatalogBytes, combinedSignal);
      if (!response.ok) {
        throw mapUpstreamStatusToError(response.status, rawText);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new AppError('ai_unavailable');
      }

      const list =
        isPlainRecord(parsed) && Array.isArray(parsed.data)
          ? parsed.data
          : Array.isArray(parsed)
            ? parsed
            : null;
      if (!list) {
        throw new AppError('ai_unavailable');
      }

      // Fetch bounded safe capability metadata from /v1/model/info using the same credential,
      // matching ONLY aliases already granted by /v1/models
      const grantedIds = new Set<string>();
      for (const entry of list) {
        if (isPlainRecord(entry) && typeof entry.id === 'string' && entry.id.trim()) {
          grantedIds.add(entry.id.trim());
        }
      }

      const infoById = new Map<string, Record<string, unknown>>();
      try {
        const infoRes = await fetcher(`${v1Base}/model/info`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: 'application/json',
          },
          signal: combinedSignal,
        });
        if (infoRes && infoRes.ok) {
          const infoText = await readBoundedBytes(
            infoRes,
            config.maxCatalogBytes,
            combinedSignal,
          );
          const infoParsed = JSON.parse(infoText) as unknown;
          const infoList =
            isPlainRecord(infoParsed) && Array.isArray(infoParsed.data)
              ? infoParsed.data
              : Array.isArray(infoParsed)
                ? infoParsed
                : [];
          for (const item of infoList) {
            if (!isPlainRecord(item)) continue;
            const alias =
              typeof item.model_name === 'string' && item.model_name.trim()
                ? item.model_name.trim()
                : typeof item.id === 'string' && item.id.trim()
                  ? item.id.trim()
                  : '';
            if (!alias || !grantedIds.has(alias)) continue;
            const mi = isPlainRecord(item.model_info) ? item.model_info : item;
            if (!infoById.has(alias)) {
              infoById.set(alias, mi);
            }
          }
        }
      } catch {
        // Optional metadata endpoint: proceed with /v1/models fields and explicit overrides
      }

      const byId = new Map<string, ModelChoice>();
      for (const entry of list) {
        const rawId = isPlainRecord(entry) && typeof entry.id === 'string' ? entry.id.trim() : '';
        const choice = toModelChoice(entry, infoById.get(rawId), config);
        if (choice && !byId.has(choice.id)) {
          byId.set(choice.id, choice);
        }
      }

      const items = [...byId.values()];
      // Configured absent default must remain null, never silently fall back to items[0]
      const defaultModel = config.defaultModel
        ? byId.has(config.defaultModel)
          ? config.defaultModel
          : null
        : (items[0]?.id ?? null);

      return {
        items,
        fetchedAt: new Date().toISOString(),
        stale: false,
        defaultModel,
      };
    },

    async *generate(input: ProviderInput, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
      ensureConfigured();
      const timeoutSignal = AbortSignal.timeout(config.generationTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const useStream = input.model.capabilities.stream === true;
      const maxTokens = Math.min(
        input.maxOutputTokens,
        input.model.maxOutputTokens ?? config.conservativeMaxOutputTokens,
      );

      const body: Record<string, unknown> = {
        model: input.model.id,
        messages: toWireMessages(input.messages, input.mode),
        stream: useStream,
        max_tokens: maxTokens,
      };


      if (input.mode === 'tools' && input.tools.length > 0) {
        body.tools = input.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      } else if (input.mode === 'json') {
        body.response_format = { type: 'json_object' };
      }

      let response: Response;
      try {
        response = await fetcher(`${v1Base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: useStream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch {
        throw new AppError('ai_unavailable');
      }

      if (!response.ok) {
        const errText = await readBoundedBytes(response, 32 * 1024, combinedSignal).catch(() => '');
        throw mapUpstreamStatusToError(response.status, errText);
      }

      const contentType = response.headers.get('content-type') || '';
      if (useStream && contentType.includes('text/event-stream') && response.body) {
        yield* parseSseStream(response.body, {
          maxResponseBytes: config.maxResponseBytes,
          maxToolArgumentBytes: config.maxContextBytesPerCall,
          signal: combinedSignal,
        });
        return;
      }

      const rawText = await readBoundedBytes(response, config.maxResponseBytes, combinedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new AppError('ai_unavailable');
      }
      if (!isPlainRecord(parsed)) throw new AppError('ai_unavailable');

      const reportedModel =
        typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const firstChoice = isPlainRecord(choices[0]) ? choices[0] : null;
      const finishReason =
        typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : null;
      const message = isPlainRecord(firstChoice?.message) ? firstChoice.message : null;

      if (message) {
        if (typeof message.content === 'string' && message.content.length > 0) {
          yield { type: 'text', delta: message.content };
        }
        if (Array.isArray(message.tool_calls)) {
          if (finishReason === 'length') throw new AppError('ai_invalid_proposal');
          for (let i = 0; i < message.tool_calls.length; i++) {
            const tc = message.tool_calls[i];
            if (!isPlainRecord(tc) || !isPlainRecord(tc.function)) continue;
            const name = typeof tc.function.name === 'string' ? tc.function.name : '';
            const rawArgs =
              typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}';
            if (!name || Buffer.byteLength(rawArgs, 'utf8') > config.maxContextBytesPerCall) {
              throw new AppError('ai_invalid_proposal');
            }
            let argsObj: unknown;
            try {
              argsObj = JSON.parse(rawArgs);
            } catch {
              throw new AppError('ai_invalid_proposal');
            }
            if (!isPlainRecord(argsObj)) throw new AppError('ai_invalid_proposal');
            yield {
              type: 'tool_call',
              id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}`,
              name,
              arguments: argsObj,
            };
          }
        }
      }

      if (isPlainRecord(parsed.usage)) {
        const promptTokens =
          typeof parsed.usage.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0;
        const completionTokens =
          typeof parsed.usage.completion_tokens === 'number' ? parsed.usage.completion_tokens : 0;
        const totalTokens =
          typeof parsed.usage.total_tokens === 'number'
            ? parsed.usage.total_tokens
            : promptTokens + completionTokens;
        yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens } };
      }

      yield { type: 'done', reportedModel, finishReason };
    },
  };
}


