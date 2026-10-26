import { describe, expect, it, vi } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import { createAiProvider } from '../../src/ai/provider';
import type { CanonicalMessage, ModelChoice, ProviderEvent } from '../../src/ai/types';

const modelWithTools: ModelChoice = {
  id: 'gemini-4-argon',
  label: 'gemini-4-argon',
  provider: 'litellm',
  capabilities: { chat: true, tools: true, json: true, stream: true },
  contextWindow: 64000,
  maxOutputTokens: 2048,
};

const modelNoStreamJsonOnly: ModelChoice = {
  id: 'claude-json',
  label: 'claude-json',
  provider: 'litellm',
  capabilities: { chat: true, tools: false, json: true, stream: false },
  contextWindow: 16000,
  maxOutputTokens: 1024,
};

describe('LiteLLM provider adapter', () => {
  it('supports native tools mode over SSE and strips incompatible internal provider fields', async () => {
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000/v1/',
      LITELLM_API_KEY: 'sk-test-secret',
    });

    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const encoder = new TextEncoder();

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body));
      const sse =
        'data: {"model":"gemini-4-argon-001","choices":[{"delta":{"content":"Revisando..."}}]}\n\n' +
        'data: {"model":"gemini-4-argon-001","choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"search_entities","arguments":"{\\"query\\":\\"users\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n' +
        'data: [DONE]\n\n';
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(sse));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const messages: CanonicalMessage[] = [
      { role: 'system', content: 'Eres un asistente.' },
      { role: 'user', content: 'Analiza users' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_prev_1', name: 'search_entities', arguments: { query: 'users' } }],
      },
      {
        role: 'tool_result',
        toolCallId: 'call_prev_1',
        toolName: 'search_entities',
        content: '{"items":[]}',
      },
    ];


    const events: ProviderEvent[] = [];
    for await (const ev of provider.generate({
      model: modelWithTools,
      messages,
      tools: [
        {
          name: 'search_entities',
          description: 'Search entities',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      mode: 'tools',
      maxOutputTokens: 1024,
    })) {
      events.push(ev);
    }

    expect(capturedUrl).toBe('http://127.0.0.1:4000/v1/chat/completions');
    expect(capturedBody.model).toBe('gemini-4-argon');
    expect(capturedBody.stream).toBe(true);
    const sentMessages = capturedBody.messages as Array<Record<string, unknown>>;
    expect(sentMessages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_prev_1',
          type: 'function',
          function: {
            name: 'search_entities',
            arguments: '{"query":"users"}',
          },
        },
      ],
    });
    expect(sentMessages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_prev_1',
      name: 'search_entities',
      content: '{"items":[]}',
    });


    expect(events).toEqual([
      { type: 'text', delta: 'Revisando...' },
      { type: 'tool_call', id: 'tc_1', name: 'search_entities', arguments: { query: 'users' } },
      { type: 'usage', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
      { type: 'done', reportedModel: 'gemini-4-argon-001', finishReason: 'tool_calls' },
    ]);
  });

  it('supports JSON mode and non-streaming fallback and sanitizes errors', async () => {
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-secret-value',
    });

    let capturedBody: Record<string, unknown> = {};
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      const payload = JSON.stringify({ text: 'Listo.', warnings: [], ops: [] });
      return new Response(
        JSON.stringify({
          model: 'claude-json-v1',
          choices: [{ message: { role: 'assistant', content: payload }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const events: ProviderEvent[] = [];
    for await (const ev of provider.generate({
      model: modelNoStreamJsonOnly,
      messages: [{ role: 'user', content: 'Agrega nota' }],
      tools: [],
      mode: 'json',
      maxOutputTokens: 512,
    })) {
      events.push(ev);
    }

    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
    expect(events).toHaveLength(3);

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Key sk-secret-value failed at https://internal.host' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(async () => {
      for await (const ev of provider.generate({
        model: modelWithTools,
        messages: [{ role: 'user', content: 'Hola' }],
        tools: [],
        mode: 'text',
        maxOutputTokens: 256,
      })) {
        void ev;
      }
    }).rejects.toSatisfy((err: unknown) => {

      const e = err as { code?: string };
      expect(e.code).toBe('ai_model_unavailable');
      expect(JSON.stringify(e)).not.toContain('sk-secret-value');
      expect(JSON.stringify(e)).not.toContain('internal.host');
      return true;
    });
  });
});
