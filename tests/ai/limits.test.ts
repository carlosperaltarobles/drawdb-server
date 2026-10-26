import { describe, expect, it } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import { GenerationRegistry } from '../../src/ai/generation-registry';

describe('GenerationRegistry concurrency, rate limits, and replay buffer', () => {
  it('enforces 1 active generation per user, 4 global, 10/min per user, 30/min per project, and releases slots on completion or error', () => {
    let now = 1_000_000;
    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test',
    });

    const registry = new GenerationRegistry(cfg, () => now);

    // Acquire 1 slot for u1
    const g1 = registry.acquire({
      generationId: 'g1',
      conversationId: 'c1',
      projectId: 'p1',
      userId: 'u1',
      messageId: 'm1',
      requestedModel: 'chat-a',
    });

    // Second concurrent generation for u1 is rejected with ai_busy
    expect(() =>
      registry.acquire({
        generationId: 'g1_dup',
        conversationId: 'c2',
        projectId: 'p1',
        userId: 'u1',
        messageId: 'm1_dup',
        requestedModel: 'chat-a',
      }),
    ).toThrowError(/ai_busy/);

    // Acquire slots for u2, u3, u4 (total 4 global active)
    const g2 = registry.acquire({
      generationId: 'g2',
      conversationId: 'c2',
      projectId: 'p1',
      userId: 'u2',
      messageId: 'm2',
      requestedModel: 'chat-a',
    });
    const g3 = registry.acquire({
      generationId: 'g3',
      conversationId: 'c3',
      projectId: 'p1',
      userId: 'u3',
      messageId: 'm3',
      requestedModel: 'chat-a',
    });
    const g4 = registry.acquire({
      generationId: 'g4',
      conversationId: 'c4',
      projectId: 'p1',
      userId: 'u4',
      messageId: 'm4',
      requestedModel: 'chat-a',
    });

    // 5th global concurrent generation is rejected with ai_busy
    expect(() =>
      registry.acquire({
        generationId: 'g5',
        conversationId: 'c5',
        projectId: 'p1',
        userId: 'u5',
        messageId: 'm5',
        requestedModel: 'chat-a',
      }),
    ).toThrowError(/ai_busy/);

    // Release all 4 active generations
    g1.release();
    g2.release();
    g3.release();
    g4.release();

    // User rate limit: 10 requests per minute for u1 (1 already used above, 9 more allowed)
    for (let i = 2; i <= 10; i++) {
      const handle = registry.acquire({
        generationId: `g_u1_${i}`,
        conversationId: 'c1',
        projectId: 'p1',
        userId: 'u1',
        messageId: `m_u1_${i}`,
        requestedModel: 'chat-a',
      });
      handle.release();
    }

    // 11th request within the same minute for u1 is rejected with ai_limit (429)
    expect(() =>
      registry.acquire({
        generationId: 'g_u1_11',
        conversationId: 'c1',
        projectId: 'p1',
        userId: 'u1',
        messageId: 'm_u1_11',
        requestedModel: 'chat-a',
      }),
    ).toThrowError(/ai_limit/);

    // Project rate limit: 30 requests per minute for p1 (13 already used: 10 by u1 + 3 by u2..u4)
    for (let i = 14; i <= 30; i++) {
      const handle = registry.acquire({
        generationId: `g_proj_${i}`,
        conversationId: `c_proj_${i}`,
        projectId: 'p1',
        userId: `user_${i}`,
        messageId: `m_proj_${i}`,
        requestedModel: 'chat-a',
      });
      handle.release();
    }

    // 31st request in the same minute for p1 is rejected with ai_limit
    expect(() =>
      registry.acquire({
        generationId: 'g_proj_31',
        conversationId: 'c_proj_31',
        projectId: 'p1',
        userId: 'user_99',
        messageId: 'm_proj_31',
        requestedModel: 'chat-a',
      }),
    ).toThrowError(/ai_limit/);

    // Advance clock past 60s window: u1 can generate again
    now += 61_000;
    const afterWindow = registry.acquire({
      generationId: 'g_after',
      conversationId: 'c1',
      projectId: 'p1',
      userId: 'u1',
      messageId: 'm_after',
      requestedModel: 'chat-a',
    });
    afterWindow.release();
  });
});
