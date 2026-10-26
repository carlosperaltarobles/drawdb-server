import { describe, expect, it, vi } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import { ModelCatalogService } from '../../src/ai/models';
import { createAiProvider } from '../../src/ai/provider';
import { AppError } from '../../src/http/app-error';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Model discovery and ModelCatalogService', () => {
  it('catalog_preserves_alias_and_strips_secrets', async () => {
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'https://litellm.internal.example/v1',
      LITELLM_API_KEY: 'sk-secret-key-do-not-leak',
      LITELLM_MODEL: 'gemini-4-argon',
      AI_MODEL_CAPABILITIES: JSON.stringify({
        'gemini-4-argon': {
          chat: true,
          tools: true,
          json: true,
          stream: true,
          contextWindow: 128000,
          maxOutputTokens: 4096,
        },
      }),
    });

    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'gemini-4-argon',
            owned_by: 'litellm',
            litellm_params: {
              api_key: 'sk-upstream-secret',
              api_base: 'https://internal-upstream.local/v1',
              model: 'vertex_ai/gemini-4-argon-internal',
            },
            model_info: { key: 'secret-token-value', mode: 'chat' },
          },
          { id: 'text-embedding-3-small', model_info: { mode: 'embedding' } },
        ],
      }),
    );

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const catalog = await provider.listModels();

    expect(catalog.defaultModel).toBe('gemini-4-argon');
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toEqual({
      id: 'gemini-4-argon',
      label: 'gemini-4-argon',
      provider: 'litellm',
      capabilities: { chat: true, tools: true, json: true, stream: true },
      contextWindow: 128000,
      maxOutputTokens: 4096,
    });

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('sk-secret-key-do-not-leak');
    expect(serialized).not.toContain('sk-upstream-secret');
    expect(serialized).not.toContain('internal-upstream.local');
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toContain('vertex_ai/gemini-4-argon-internal');
  });

  it('base_url_has_one_v1', async () => {
    const urlsCalled: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      urlsCalled.push(String(input));
      return jsonResponse({ data: [{ id: 'gemini-4-argon', model_info: { mode: 'chat' } }] });
    });

    for (const rawBase of [
      'http://127.0.0.1:4000',
      'http://127.0.0.1:4000/',
      'http://127.0.0.1:4000/v1',
      'http://127.0.0.1:4000/v1/',
    ]) {
      const cfg = parseAiConfig({
        AI_ENABLED: 'true',
        LITELLM_BASE_URL: rawBase,
        LITELLM_API_KEY: 'sk-test',
      });
      const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
      await provider.listModels();
    }

    expect(urlsCalled).toEqual([
      'http://127.0.0.1:4000/v1/models',
      'http://127.0.0.1:4000/v1/models',
      'http://127.0.0.1:4000/v1/models',
      'http://127.0.0.1:4000/v1/models',
    ]);
  });

  it('unknown_capability_is_not_supported', async () => {
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000/v1',
      LITELLM_API_KEY: 'sk-test',
    });

    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'gpt-4o-tools-json', owned_by: 'openai' }] }),
    );

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const service = new ModelCatalogService({ provider, config: cfg });
    const catalog = await service.get();

    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.capabilities).toEqual({
      chat: true,
      tools: null,
      json: null,
      stream: null,
    });

    const resolved = await service.resolveModel('gpt-4o-tools-json');
    expect(resolved.capabilities.tools).toBeNull();
    expect(resolved.capabilities.json).toBeNull();
    expect(service.canPropose(resolved)).toBe(false);
  });

  it('ttl_and_singleflight_follow_policy', async () => {
    let now = 1_000_000;
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test',
      AI_ALLOWED_MODELS: 'model-a,model-b',
    });

    let resolveFetch!: (res: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const service = new ModelCatalogService({ provider, config: cfg, now: () => now });

    const p1 = service.get({ policyScope: 'policy-1' });
    const p2 = service.get({ policyScope: 'policy-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(
      jsonResponse({
        data: [
          { id: 'model-a', model_info: { mode: 'chat' } },
          { id: 'model-c-blocked', model_info: { mode: 'chat' } },
        ],
      }),
    );

    const [cat1, cat2] = await Promise.all([p1, p2]);
    expect(cat1.items.map((i) => i.id)).toEqual(['model-a']);
    expect(cat2.items.map((i) => i.id)).toEqual(['model-a']);

    now += 59_999;
    await service.get({ policyScope: 'policy-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'model-b', model_info: { mode: 'chat' } }] }),
    );
    const catScope2 = await service.get({ policyScope: 'policy-2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(catScope2.items.map((i) => i.id)).toEqual(['model-b']);

    now += 2;
    fetcher.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'model-a', model_info: { mode: 'chat' } }] }),
    );
    await service.get({ policyScope: 'policy-1' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refresh_failure_does_not_change_model', async () => {
    let now = 2_000_000;
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test',
      LITELLM_MODEL: 'default-alias',
    });

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'default-alias', model_info: { mode: 'chat' } },
            { id: 'chosen-alias', model_info: { mode: 'chat' } },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:4000'));

    const provider = createAiProvider(cfg, fetcher as unknown as typeof fetch);
    const service = new ModelCatalogService({ provider, config: cfg, now: () => now });

    const initial = await service.get({ userId: 'u1' });
    expect(initial.stale).toBe(false);

    now += 15_000;
    const afterFailure = await service.get({ refresh: true, userId: 'u1' });
    expect(afterFailure.stale).toBe(true);
    expect(afterFailure.items.map((m) => m.id)).toEqual(['default-alias', 'chosen-alias']);

    await expect(service.resolveModel('missing-model')).rejects.toEqual(
      new AppError('ai_model_unavailable'),
    );
  });
});

