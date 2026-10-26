import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../../src/ai/sse';

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

describe('SSE incremental parser', () => {
  it('sse_handles_split_utf8_and_bounded_tool_arguments', async () => {
    const encoder = new TextEncoder();
    // Multibyte UTF-8 characters ("Diseño áéíóú 🚀") split right in the middle of codepoints
    const frame1 =
      'data: {"id":"1","model":"gemini-4-argon","choices":[{"delta":{"content":"Diseño áéíóú 🚀"}}]}\n\n';
    const frame2 =
      'data: {"id":"1","model":"gemini-4-argon","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"propose_changes","arguments":"{\\"ops\\":["}}]}}]}\n\n';
    const frame3 =
      'data: {"id":"1","model":"gemini-4-argon","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"t\\":\\"add\\",\\"coll\\":\\"notes\\",\\"index\\":0,\\"item\\":{\\"id\\":\\"n1\\",\\"title\\":\\"Nota\\"}}]}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":20,"total_tokens":35}}\n\ndata: [DONE]\n\n';


    const bytes = encoder.encode(frame1 + frame2 + frame3);
    // Split every 5 bytes so multibyte UTF-8 characters and JSON lines are fragmented
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) {
      chunks.push(bytes.subarray(i, Math.min(bytes.length, i + 5)));
    }

    const events = [];
    for await (const ev of parseSseStream(streamFromChunks(chunks), {
      maxResponseBytes: 64 * 1024,
      maxToolArgumentBytes: 16 * 1024,
    })) {
      events.push(ev);
    }

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.map((e) => e.delta).join('')).toBe('Diseño áéíóú 🚀');

    // Tool call must only be emitted once finished, never as executable partial arguments
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'propose_changes',
      arguments: {
        ops: [
          {
            t: 'add',
            coll: 'notes',
            index: 0,
            item: { id: 'n1', title: 'Nota' },
          },
        ],
      },
    });

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage).toEqual({
      promptTokens: 15,
      completionTokens: 20,
      totalTokens: 35,
    });

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.reportedModel).toBe('gemini-4-argon');
    expect(doneEvents[0]?.finishReason).toBe('tool_calls');

    // Bound tool arguments: exceeding maxToolArgumentBytes must reject cleanly
    const hugeArg = 'x'.repeat(2048);
    const hugeFrame = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"propose","arguments":"${hugeArg}"}}]}}]}\n\n`;
    await expect(async () => {
      for await (const ev of parseSseStream(streamFromChunks([encoder.encode(hugeFrame)]), {
        maxResponseBytes: 64 * 1024,
        maxToolArgumentBytes: 512,
      })) {
        void ev;
      }
    }).rejects.toMatchObject({ code: 'ai_invalid_proposal' });
  });

  it('rejects truncated stream when finish_reason is length or [DONE] is missing with unfinished tool call', async () => {
    const encoder = new TextEncoder();
    const truncated =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_trunc","function":{"name":"propose_changes","arguments":"{\\"ops\\":["}}]},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    await expect(async () => {
      for await (const ev of parseSseStream(streamFromChunks([encoder.encode(truncated)]), {
        maxResponseBytes: 64 * 1024,
        maxToolArgumentBytes: 16 * 1024,
      })) {
        void ev;
      }
    }).rejects.toMatchObject({ code: 'ai_invalid_proposal' });

  });
});
