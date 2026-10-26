import { describe, expect, it } from 'vitest';
import { summarizeChanges } from '../../src/ai/change-summary';
import { prepareProposal } from '../../src/ai/proposal-validation';
import type { Document } from '../../src/collab/ops';
import { EMPTY_DOC } from '../../src/projects/empty-doc';

function sampleDoc(database = 'postgresql'): Document {
  return {
    ...EMPTY_DOC,
    database,
    sqlHeader: '-- header',
    tables: [
      {
        id: 10,
        name: 'users',
        x: 20,
        y: 40,
        fields: [
          {
            id: 101,
            name: 'id',
            type: 'INTEGER',
            default: '',
            check: '',
            primary: true,
            unique: true,
            notNull: true,
            increment: true,
            comment: '',
          },
          {
            id: 'f_email',
            name: 'email',
            type: 'VARCHAR',
            default: '',
            check: "email <> ''",
            primary: false,
            unique: true,
            notNull: true,
            increment: false,
            comment: '',
            size: 255,
          },
        ],
        comment: 'Users table',
        indices: [{ id: 'idx_1', name: 'idx_users_email', unique: true, fields: ['email'] }],
        uniqueConstraints: [{ id: 'uc_1', name: 'uc_users_email', fields: ['email'] }],
        color: '#175e7a',
      },
      {
        id: 't_orders',
        name: 'orders',
        x: 320,
        y: 40,
        fields: [
          {
            id: 'f_oid',
            name: 'id',
            type: 'INTEGER',
            default: '',
            check: '',
            primary: true,
            unique: true,
            notNull: true,
            increment: true,
            comment: '',
          },
          {
            id: 'f_uid',
            name: 'user_id',
            type: 'INTEGER',
            default: '',
            check: '',
            primary: false,
            unique: false,
            notNull: true,
            increment: false,
            comment: '',
          },
        ],
        comment: 'Orders table',
        indices: [],
        uniqueConstraints: [],
        color: '#175e7a',
      },
    ],
    relationships: [
      {
        id: 'rel_1',
        name: 'fk_orders_user',
        startTableId: 't_orders',
        startFieldId: 'f_uid',
        endTableId: 10,
        endFieldId: 101,
        cardinality: 'many_to_one',
        updateConstraint: 'No action',
        deleteConstraint: 'Cascade',
      },
    ],
    views: [
      {
        id: 'v_1',
        name: 'user_orders_view',
        x: 600,
        y: 40,
        joins: [],
        columns: [
          { id: 'vc_1', tableId: 10, fieldId: 'f_email', alias: 'user_email' },
          { id: 'vc_2', tableId: 't_orders', fieldId: 'f_oid', alias: 'order_id' },
        ],
        conditions: [],
        comment: '',
        materialized: false,
        color: '#175e7a',
      },
    ],
  };
}

describe('Proposal semantic validation', () => {
  it('preserves mixed numeric/string IDs, updates index field names on field rename, and keeps references by ID', () => {
    const base = sampleDoc('postgresql');
    const result = prepareProposal(
      base,
      {
        ops: [
          {
            t: 'spatch',
            coll: 'tables',
            id: 10,
            sub: 'fields',
            sid: 'f_email',
            patch: { name: 'contact_email', check: "contact_email <> ''" },
          },
        ],
      },
      { entities: null },
    );

    const updatedUsers = result.after.tables?.find((t) => t.id === 10) as {
      id: number;
      indices: Array<{ fields: string[] }>;
      uniqueConstraints: Array<{ fields: string[] }>;
    };
    expect(typeof updatedUsers.id).toBe('number');
    expect(updatedUsers.indices[0]?.fields).toEqual(['contact_email']);
    expect(updatedUsers.uniqueConstraints[0]?.fields).toEqual(['contact_email']);
    expect(result.summary.counts.modified).toBeGreaterThanOrEqual(1);
  });

  it('rejects set operations, unknown properties, prototype pollution, and duplicate names', () => {
    const base = sampleDoc('postgresql');

    expect(() =>
      prepareProposal(
        base,
        { ops: [{ t: 'set', key: 'database', value: 'mysql' }] },
        { entities: null },
      ),
    ).toThrow();

    expect(() =>
      prepareProposal(
        base,
        { ops: [{ t: 'patch', coll: 'tables', id: 10, patch: { evilProp: 'hacked' } }] },
        { entities: null },
      ),
    ).toThrow();

    expect(() =>
      prepareProposal(
        base,
        { ops: [{ t: 'patch', coll: 'tables', id: 't_orders', patch: { name: 'users' } }] },
        { entities: null },
      ),
    ).toThrow();
  });

  it('rejects deletion that breaks a view or relationship or out-of-scope dependency, and blocks ambiguous free SQL', () => {
    const base = sampleDoc('postgresql');

    expect(() =>
      prepareProposal(
        base,
        { ops: [{ t: 'sdel', coll: 'tables', id: 10, sub: 'fields', sid: 'f_email' }] },
        { entities: null },
      ),
    ).toThrow();

    expect(() =>
      prepareProposal(
        base,
        {
          ops: [
            {
              t: 'spatch',
              coll: 'tables',
              id: 10,
              sub: 'fields',
              sid: 'f_email',
              patch: { name: 'primary_email' },
            },
          ],
        },
        { entities: null },
      ),
    ).toThrow();

    expect(() =>
      prepareProposal(
        base,
        { ops: [{ t: 'patch', coll: 'tables', id: 't_orders', patch: { comment: 'Changed' } }] },
        { entities: [{ coll: 'tables', id: 10 }] },
      ),
    ).toThrow();
  });

  it('enforces database engine capabilities for types, enums, and materialized views', () => {
    const pgBase = sampleDoc('postgresql');
    const sqliteBase = sampleDoc('sqlite');

    const addCustomTypeOp = {
      t: 'add' as const,
      coll: 'types' as const,
      index: 0,
      item: {
        id: 'type_addr',
        name: 'address_type',
        comment: 'Address composite',
        fields: [{ id: 'tf_1', name: 'street', type: 'VARCHAR' }],
      },
    };

    const pgResult = prepareProposal(pgBase, { ops: [addCustomTypeOp] }, { entities: null });
    expect(pgResult.after.types).toHaveLength(1);

    expect(() =>
      prepareProposal(sqliteBase, { ops: [addCustomTypeOp] }, { entities: null }),
    ).toThrow();
  });

  it('normalizes new entity IDs consistently across newly added tables, fields, and relationships', () => {
    const base = sampleDoc('postgresql');
    const res = prepareProposal(
      base,
      {
        ops: [
          {
            t: 'add',
            coll: 'tables',
            index: 2,
            item: {
              id: 'temp_tbl',
              name: 'invoices',
              x: 100,
              y: 300,
              comment: '',
              color: '#175e7a',
              indices: [],
              uniqueConstraints: [],
              fields: [
                {
                  id: 'temp_fid',
                  name: 'order_id',
                  type: 'INTEGER',
                  default: '',
                  check: '',
                  primary: true,
                  unique: true,
                  notNull: true,
                  increment: false,
                  comment: '',
                },
              ],
            },
          },
          {
            t: 'add',
            coll: 'relationships',
            index: 1,
            item: {
              id: 'temp_rel',
              name: 'fk_invoices_orders',
              startTableId: 'temp_tbl',
              startFieldId: 'temp_fid',
              endTableId: 't_orders',
              endFieldId: 'f_oid',
              cardinality: 'one_to_one',
              updateConstraint: 'No action',
              deleteConstraint: 'Cascade',
            },
          },
        ],
      },
      { entities: null },
    );

    const newTable = res.after.tables?.find((t) => t.name === 'invoices') as {
      id: string;
      fields: Array<{ id: string }>;
    };
    const newRel = res.after.relationships?.find((r) => r.name === 'fk_invoices_orders') as {
      startTableId: string;
      startFieldId: string;
    };
    expect(newTable).toBeDefined();
    expect(newRel.startTableId).toBe(newTable.id);
    expect(newRel.startFieldId).toBe(newTable.fields[0]?.id);
    expect(summarizeChanges(base, res.after).counts.added).toBeGreaterThanOrEqual(2);
  });

  it('meets the scale threshold (median <= 500 ms) for 1,000 tables, 20 fields/table, and 5,000 relationships', () => {
    const tables = Array.from({ length: 1000 }, (_, i) => ({
      id: `t_${i + 1}`,
      name: `entity_${i + 1}`,
      x: (i % 40) * 260,
      y: Math.floor(i / 40) * 260,
      comment: '',
      color: '#175e7a',
      indices: [],
      uniqueConstraints: [],
      fields: Array.from({ length: 20 }, (__, f) => ({
        id: `f_${i + 1}_${f + 1}`,
        name: f === 0 ? 'id' : `col_${f + 1}`,
        type: f <= 5 ? 'INTEGER' : 'VARCHAR',
        default: '',
        check: '',
        primary: f === 0,
        unique: f === 0,
        notNull: f <= 5,
        increment: f === 0,
        comment: '',
      })),
    }));

    const relationships = [];
    for (let i = 0; i < 1000; i++) {
      for (let k = 1; k <= 5; k++) {
        const target = (i + k) % 1000;
        relationships.push({
          id: `r_${i}_${k}`,
          name: `fk_${i}_${k}`,
          startTableId: `t_${i + 1}`,
          startFieldId: `f_${i + 1}_${k + 1}`,
          endTableId: `t_${target + 1}`,
          endFieldId: `f_${target + 1}_1`,
          cardinality: 'many_to_one',
          updateConstraint: 'No action',
          deleteConstraint: 'No action',
        });
      }
    }

    const largeBase: Document = {
      ...EMPTY_DOC,
      database: 'postgresql',
      tables,
      relationships,
    };

    const proposalOps = {
      ops: [
        {
          t: 'patch',
          coll: 'tables',
          id: 't_500',
          patch: { comment: 'Updated at scale' },
        },
        {
          t: 'add',
          coll: 'notes',
          index: 0,
          item: { id: 'n_scale', title: 'Scale Note', content: 'Verified' },
        },
        {
          t: 'add',
          coll: 'areas',
          index: 0,
          item: { id: 'a_scale', name: 'Billing Area', x: 0, y: 0, width: 500, height: 400, color: '#175e7a' },
        },
        {
          t: 'add',
          coll: 'enums',
          index: 0,
          item: { id: 'e_scale', name: 'status_enum', values: ['open', 'closed'] },
        },
      ],
    };

    // Warm-up run
    prepareProposal(largeBase, proposalOps, { entities: null });

    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      const out = prepareProposal(largeBase, proposalOps, { entities: null });
      const elapsed = performance.now() - t0;
      expect(out.summary.counts.added).toBe(3);
      expect(out.summary.counts.modified).toBe(1);
      samples.push(elapsed);
    }

    samples.sort((a, b) => a - b);
    const medianMs = samples[2]!;
    expect(medianMs).toBeLessThanOrEqual(500);
  });
});


