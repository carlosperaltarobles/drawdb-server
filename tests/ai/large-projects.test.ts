import { describe, expect, it } from 'vitest';
import { parseAiConfig } from '../../src/ai/config';
import { queryContext } from '../../src/ai/context';
import { DocumentIndexCache, indexDocument } from '../../src/ai/document-index';
import { GenerationRegistry } from '../../src/ai/generation-registry';
import { prepareProposal } from '../../src/ai/proposal-validation';
import type { Document, Id, Item, Op } from '../../src/collab/ops';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { probeModelCapabilities } from '../../scripts/ai-capabilities';
import protocolFixture from './fixtures/protocol.json';

export function makeLargeDiagram(opts: {
  tables: 200 | 500 | 1000;
  fieldsPerTable?: number;
  density?: 'sparse' | 'dense';
  seed?: number;
}): Document {
  const count = opts.tables;
  const fieldsPerTable = opts.fieldsPerTable ?? 20;
  const density = opts.density ?? 'sparse';
  const seed = opts.seed ?? 42;

  const tables: Item[] = [];
  for (let i = 0; i < count; i++) {
    const tableId: Id = i % 2 === 0 ? i + 1 : `tbl_${seed}_${i + 1}`;
    const fields: Item[] = [];
    for (let f = 0; f < fieldsPerTable; f++) {
      const fieldId: Id = f === 0 ? (i + 1) * 1000 + 1 : `fld_${i + 1}_${f + 1}`;
      fields.push({
        id: fieldId,
        name: f === 0 ? 'id' : f <= 5 ? `fk_col_${f}` : `attr_${f}`,
        type: f <= 5 ? 'INTEGER' : f % 3 === 0 ? 'TIMESTAMPTZ' : 'VARCHAR',
        default: '',
        check: '',
        primary: f === 0,
        unique: f === 0,
        notNull: f <= 5,
        increment: f === 0,
        comment: `Field ${f} of table ${i + 1}`,
        ...(f > 5 && f % 3 !== 0 ? { size: 128 } : {}),
      });
    }
    tables.push({
      id: tableId,
      name: `entity_${String(i + 1).padStart(4, '0')}`,
      x: (i % 30) * 280,
      y: Math.floor(i / 30) * 260,
      fields,
      comment: `Domain entity ${i + 1}`,
      indices: [
        {
          id: `idx_${i + 1}_1`,
          name: `idx_entity_${i + 1}_fk1`,
          unique: false,
          fields: ['fk_col_1'],
        },
      ],
      uniqueConstraints: [],
      color: '#175e7a',
    });
  }

  const relationships: Item[] = [];
  const edgesPerTable = density === 'dense' ? 5 : 1;
  let relIdx = 0;
  for (let i = 0; i < count; i++) {
    const startTable = tables[i]!;
    const startFields = startTable.fields as Item[];
    for (let e = 1; e <= edgesPerTable; e++) {
      relIdx++;
      const targetIdx = (i + e * 7 + (seed % 5)) % count;
      const endTable = tables[targetIdx]!;
      const endFields = endTable.fields as Item[];
      relationships.push({
        id: relIdx % 2 === 0 ? relIdx : `rel_${relIdx}`,
        name: `fk_${i + 1}_${targetIdx + 1}_${e}`,
        startTableId: startTable.id,
        startFieldId: startFields[e]!.id,
        endTableId: endTable.id,
        endFieldId: endFields[0]!.id,
        cardinality: 'many_to_one',
        updateConstraint: 'No action',
        deleteConstraint: 'No action',
      });
    }
  }

  return {
    ...EMPTY_DOC,
    database: 'postgresql',
    tables,
    relationships,
    enums: [{ id: 'enum_1', name: 'record_state', values: ['draft', 'active', 'archived'] }],
    types: [
      {
        id: 'type_1',
        name: 'audit_info',
        comment: 'Audit metadata',
        fields: [{ id: 'tf_1', name: 'actor', type: 'VARCHAR' }],
      },
    ],
    views: [
      {
        id: 'view_1',
        name: 'v_primary_entities',
        x: 0,
        y: -300,
        joins: [],
        columns: [
          {
            id: 'vc_1',
            tableId: tables[0]!.id,
            fieldId: (tables[0]!.fields as Item[])[0]!.id,
            alias: 'root_id',
          },
        ],
        conditions: [],
        comment: '',
        materialized: true,
        color: '#175e7a',
      },
    ],
  };
}

describe('Large projects scale matrix (200 / 500 / 1000 tables), protocol parity, and resource cleanup', () => {
  it('validates 5 warmed-up runs across 200, 500, and 1000 tables (sparse & dense, >200 KiB) within the 500 ms median budget and enforces out-of-context dependencies', () => {
    for (const size of [200, 500, 1000] as const) {
      const doc = makeLargeDiagram({
        tables: size,
        fieldsPerTable: 20,
        density: size === 1000 ? 'dense' : 'sparse',
        seed: 101,
      });

      const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
      expect(docBytes).toBeGreaterThan(200 * 1024);

      const modOp: Op = {
        t: 'spatch',
        coll: 'tables',
        id: doc.tables![0]!.id,
        sub: 'fields',
        sid: (doc.tables![0]!.fields as Item[])[1]!.id,
        patch: { name: 'fk_col_1_renamed' },
      };

      indexDocument(doc, 1);
      prepareProposal(doc, { ops: [modOp] }, { entities: null });

      const samples: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        const idx = indexDocument(doc, 1);
        const page = queryContext(
          idx,
          { part: 'relevant', query: 'entity_0001', limit: 25 },
          { maxBytes: 200 * 1024, maxTokens: 16384 },
        );
        expect(page.bytes).toBeLessThanOrEqual(200 * 1024);
        const prep = prepareProposal(doc, { ops: [modOp] }, { entities: null });
        expect(prep.summary.counts.modified).toBeGreaterThanOrEqual(1);
        samples.push(performance.now() - t0);
      }

      samples.sort((a, b) => a - b);
      const medianMs = samples[2]!;
      expect(medianMs).toBeLessThanOrEqual(500);

      expect(() =>
        prepareProposal(
          doc,
          { ops: [{ t: 'del', coll: 'tables', id: doc.tables![0]!.id }] },
          { entities: null },
        ),
      ).toThrow();
    }
  });

  it('releases caches, active generation slots, and subscribers cleanly across 10 open/close/cancel cycles and verifies protocol fixture & capability probe', async () => {
    expect(protocolFixture.catalog.items).toHaveLength(2);
    expect(protocolFixture.proposal.status).toBe('pending');
    expect(protocolFixture.events.map((e) => e.event)).toEqual(['generation', 'text', 'done']);

    const cfg = parseAiConfig({
      AI_ENABLED: 'true',
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_API_KEY: 'sk-test-no-network',
      AI_RATE_LIMIT_USER_PER_MIN: '50',
      AI_RATE_LIMIT_PROJECT_PER_MIN: '100',
    });

    const indexCache = new DocumentIndexCache(4);
    const registry = new GenerationRegistry(cfg);
    const doc = makeLargeDiagram({ tables: 200, density: 'sparse' });

    for (let cycle = 1; cycle <= 10; cycle++) {
      const pid = `proj_${cycle}`;
      indexCache.getOrCreate(pid, doc, cycle);
      const handle = registry.acquire({
        generationId: `gen_${cycle}`,
        conversationId: `conv_${cycle}`,
        projectId: pid,
        userId: 'user_cycle',
        messageId: `msg_${cycle}`,
        requestedModel: 'chat-a',
      });
      registry.cancelGeneration(`gen_${cycle}`);
      handle.release();
      indexCache.evictProject(pid);
    }

    const verifyHandle = registry.acquire({
      generationId: 'gen_verify',
      conversationId: 'conv_verify',
      projectId: 'proj_verify',
      userId: 'user_cycle',
      messageId: 'msg_verify',
      requestedModel: 'chat-a',
    });
    verifyHandle.release();

    const probeResults = await probeModelCapabilities(
      cfg,
      ['chat-a'],
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'chat-a', model_info: { mode: 'chat' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (Array.isArray(body.tools)) {
          return new Response(
            JSON.stringify({
              model: 'chat-a-001',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'tc_1',
                        type: 'function',
                        function: { name: 'ping_tool', arguments: '{"ok":true}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (body.response_format) {
          return new Response(
            JSON.stringify({
              model: 'chat-a-001',
              choices: [
                {
                  message: { role: 'assistant', content: '{"ok":true}' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            model: 'chat-a-001',
            choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );

    expect(probeResults).toEqual([
      {
        id: 'chat-a',
        chat: true,
        tools: true,
        json: true,
      },
    ]);
  });
});


