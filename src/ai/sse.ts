import { AppError } from '../http/app-error';
import type { ProviderEvent, ProviderUsage } from './types';

export type SseParseOptions = {
  maxResponseBytes?: number;
  maxToolArgumentBytes?: number;
  signal?: AbortSignal;
};

type PartialToolCall = {
  id: string;
  name: string;
  argsBuffer: string;
  argsBytes: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseUsage(raw: unknown): ProviderUsage | null {
  if (!isPlainRecord(raw)) return null;
  const promptTokens =
    typeof raw.prompt_tokens === 'number' && Number.isFinite(raw.prompt_tokens)
      ? raw.prompt_tokens
      : 0;
  const completionTokens =
    typeof raw.completion_tokens === 'number' && Number.isFinite(raw.completion_tokens)
      ? raw.completion_tokens
      : 0;
  const totalTokens =
    typeof raw.total_tokens === 'number' && Number.isFinite(raw.total_tokens)
      ? raw.total_tokens
      : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  opts: SseParseOptions = {},
): AsyncIterable<ProviderEvent> {
  const maxResponseBytes = opts.maxResponseBytes ?? 1024 * 1024;
  const maxToolArgumentBytes = opts.maxToolArgumentBytes ?? 200 * 1024;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let totalBytes = 0;
  let buffer = '';
  let reportedModel: string | null = null;
  let finishReason: string | null = null;
  let latestUsage: ProviderUsage | null = null;
  let usageEmitted = false;
  let doneEmitted = false;
  let sawDoneMarker = false;
  const toolCalls = new Map<number, PartialToolCall>();


  const flushCompletedToolCalls = function* (): Iterable<ProviderEvent> {
    if (toolCalls.size === 0) return;
    if (finishReason === 'length') {
      throw new AppError('ai_invalid_proposal');
    }
    const sortedIndices = [...toolCalls.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const tc = toolCalls.get(idx)!;
      if (!tc.name) throw new AppError('ai_invalid_proposal');
      let parsedArgs: unknown = {};
      if (tc.argsBuffer.trim().length > 0) {
        try {
          parsedArgs = JSON.parse(tc.argsBuffer);
        } catch {
          throw new AppError('ai_invalid_proposal');
        }
      }
      if (!isPlainRecord(parsedArgs)) throw new AppError('ai_invalid_proposal');
      yield {
        type: 'tool_call',
        id: tc.id || `call_${idx}`,
        name: tc.name,
        arguments: parsedArgs,
      };
    }
    toolCalls.clear();
  };

  const processLine = function* (rawLine: string): Iterable<ProviderEvent> {
    const line = rawLine.trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;

    if (payload === '[DONE]') {
      sawDoneMarker = true;
      if (!finishReason && toolCalls.size > 0) {
        throw new AppError('ai_invalid_proposal');
      }
      yield* flushCompletedToolCalls();
      if (latestUsage && !usageEmitted) {
        usageEmitted = true;
        yield { type: 'usage', usage: latestUsage };
      }
      if (!doneEmitted) {
        doneEmitted = true;
        yield { type: 'done', reportedModel, finishReason };
      }
      return;
    }


    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new AppError('ai_unavailable');
    }
    if (!isPlainRecord(parsed)) return;

    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      reportedModel = parsed.model.trim();
    }
    const usage = parseUsage(parsed.usage);
    if (usage) latestUsage = usage;

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      if (!isPlainRecord(choice)) continue;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = isPlainRecord(choice.delta) ? choice.delta : null;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawTc of delta.tool_calls) {
          if (!isPlainRecord(rawTc)) continue;
          const index =
            typeof rawTc.index === 'number' && Number.isInteger(rawTc.index) && rawTc.index >= 0
              ? rawTc.index
              : 0;
          let current = toolCalls.get(index);
          if (!current) {
            current = {
              id: typeof rawTc.id === 'string' ? rawTc.id : `call_${index}`,
              name: '',
              argsBuffer: '',
              argsBytes: 0,
            };
            toolCalls.set(index, current);
          } else if (typeof rawTc.id === 'string' && rawTc.id) {
            current.id = rawTc.id;
          }
          const fn = isPlainRecord(rawTc.function) ? rawTc.function : null;
          if (!fn) continue;
          if (typeof fn.name === 'string' && fn.name) current.name += fn.name;
          if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
            current.argsBytes += Buffer.byteLength(fn.arguments, 'utf8');
            if (current.argsBytes > maxToolArgumentBytes) {
              throw new AppError('ai_invalid_proposal');
            }
            current.argsBuffer += fn.arguments;
          }
        }
      }
    }
  };

  try {
    while (true) {
      if (opts.signal?.aborted) throw new AppError('ai_unavailable');
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) throw new AppError('ai_invalid_proposal');
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);
          yield* processLine(line);
          newlineIdx = buffer.indexOf('\n');
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      for (const line of buffer.split('\n')) {
        yield* processLine(line.replace(/\r$/, ''));
      }
    }
    if (!doneEmitted) {
      if (!sawDoneMarker && !finishReason) {
        throw new AppError('ai_invalid_proposal');
      }
      yield* flushCompletedToolCalls();
      if (latestUsage && !usageEmitted) {
        usageEmitted = true;
        yield { type: 'usage', usage: latestUsage };
      }
      yield { type: 'done', reportedModel, finishReason };
    }

  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

