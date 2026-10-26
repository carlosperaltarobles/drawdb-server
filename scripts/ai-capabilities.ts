import { normalizeLitellmV1Url, parseAiConfig, type AiConfig } from '../src/ai/config';

export type CapabilityProbeResult = {
  id: string;
  chat: boolean;
  tools: boolean;
  json: boolean;
};

/**
 * Manual capability verification helper.
 * Reads configuration from environment (never from CLI arguments), never logs credentials,
 * and sends minimal synthetic messages to verify text, tool calling, and JSON object support
 * per alias before enabling proposals in `AI_MODEL_CAPABILITIES`.
 */
export async function probeModelCapabilities(
  config: AiConfig,
  modelIds: string[],
  fetcher: typeof fetch = fetch,
): Promise<CapabilityProbeResult[]> {
  const v1Base = normalizeLitellmV1Url(config.baseUrl);
  if (!v1Base || !config.apiKey) {
    throw new Error('LITELLM_BASE_URL and LITELLM_API_KEY must be configured in environment');
  }

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  let targets = modelIds.filter(Boolean);
  if (targets.length === 0) {
    const modelsRes = await fetcher(`${v1Base}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(config.catalogTimeoutMs),
    });
    if (!modelsRes.ok) {
      throw new Error(`Model discovery failed with status ${modelsRes.status}`);
    }
    const parsed = (await modelsRes.json()) as { data?: Array<{ id?: string }> };
    targets = (parsed.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
      .slice(0, 2);
  }

  const results: CapabilityProbeResult[] = [];

  for (const id of targets) {
    let chat = false;
    let tools = false;
    let json = false;

    try {
      const chatRes = await fetcher(`${v1Base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'Respond with OK' }],
          max_tokens: 16,
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (chatRes.ok) {
        const data = (await chatRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        chat = Boolean(data.choices?.[0]?.message?.content);
      }
    } catch {
      chat = false;
    }

    if (chat) {
      try {
        const toolRes = await fetcher(`${v1Base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: id,
            messages: [{ role: 'user', content: 'Call ping_tool with ok=true' }],
            tools: [
              {
                type: 'function',
                function: {
                  name: 'ping_tool',
                  description: 'Synthetic capability check tool',
                  parameters: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                  },
                },
              },
            ],
            tool_choice: 'auto',
            max_tokens: 64,
            stream: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (toolRes.ok) {
          const data = (await toolRes.json()) as {
            choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }>;
          };
          tools = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'ping_tool';
        }
      } catch {
        tools = false;
      }

      try {
        const jsonRes = await fetcher(`${v1Base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: id,
            messages: [{ role: 'user', content: 'Return JSON {"ok":true}' }],
            response_format: { type: 'json_object' },
            max_tokens: 32,
            stream: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (jsonRes.ok) {
          const data = (await jsonRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content ?? '';
          const parsed = JSON.parse(content) as { ok?: unknown };
          json = parsed.ok === true;
        }
      } catch {
        json = false;
      }
    }

    results.push({ id, chat, tools, json });
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((a) => a.startsWith('--key') || a.startsWith('sk-'))) {
    process.stderr.write('Error: Do not pass API keys on the command line. Use environment variables.\n');
    process.exit(1);
  }
  const cfg = parseAiConfig(process.env);
  probeModelCapabilities(cfg, args)
    .then((res) => {
      process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), models: res }, null, 2)}\n`);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Capability probe failed';
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    });
}
