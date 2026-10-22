import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import isEqual from 'lodash/isEqual';
import {
  applyOp,
  applyOps,
  diffDoc,
  type Document,
  type Item,
  type Op,
} from '../../src/collab/ops';
import { validateOps } from '../../src/collab/validate';
import { colorFor } from '../../src/collab/colors';

const fixtures = JSON.parse(readFileSync('src/collab/__fixtures__/ops.fixtures.json', 'utf8')) as {
  name: string;
  base: Document;
  ops: Op[];
  expected: Document;
  ok: boolean;
}[];
const base = (): Document => ({
  database: 'generic',
  sqlHeader: '',
  tables: [
    { id: 't', name: 'Table', fields: [{ id: 0, name: 'a' }], indices: [], uniqueConstraints: [] },
  ],
  relationships: [],
  notes: [],
  areas: [],
  views: [],
  enums: [],
  types: [],
});

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

describe('document operations', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const result = applyOps(freezeDeep(fixture.base), freezeDeep(fixture.ops));
      expect(result.doc).toEqual(fixture.expected);
      expect(result.ok).toBe(fixture.ok);
      expect(validateOps(fixture.ops)).toEqual(fixture.ops);
    });
  }

  it('records accepted idempotent operations and continues after rejected patches', () => {
    const doc = base();
    const ops: Op[] = [
      { t: 'add', coll: 'tables', item: { id: 't' }, index: 0 },
      { t: 'patch', coll: 'tables', id: 'missing', patch: { name: 'gone' } },
      { t: 'del', coll: 'notes', id: 'missing' },
      { t: 'set', key: 'database', value: 'generic' },
    ];
    expect(applyOps(doc, ops)).toEqual({ doc, ok: false, applied: [ops[0], ops[2], ops[3]] });
    expect(applyOps(doc, ops).doc).toBe(doc);
  });

  it('copies only the changed path and preserves untouched objects', () => {
    const doc = freezeDeep(base());
    const result = applyOp(doc, {
      t: 'spatch',
      coll: 'tables',
      id: 't',
      sub: 'fields',
      sid: 0,
      patch: { name: 'new' },
    });
    expect(result.doc).not.toBe(doc);
    expect(result.doc.tables).not.toBe(doc.tables);
    expect(result.doc.tables![0]).not.toBe(doc.tables![0]);
    expect(result.doc.notes).toBe(doc.notes);
    expect(result.doc.tables![0].indices).toBe(doc.tables![0].indices);
    expect(doc.tables![0].fields).toEqual([{ id: 0, name: 'a' }]);
  });

  it('orders subcollections without duplicating repeated ids and clamps insertion', () => {
    const result = applyOps(base(), [
      { t: 'sadd', coll: 'tables', id: 't', sub: 'fields', item: { id: 'b' }, index: 100 },
      { t: 'sadd', coll: 'tables', id: 't', sub: 'fields', item: { id: 'c' }, index: 0 },
      { t: 'sorder', coll: 'tables', id: 't', sub: 'fields', ids: ['b', 'b', 'missing', 0] },
    ]);
    expect(result.doc.tables![0].fields).toEqual([{ id: 'b' }, { id: 0, name: 'a' }, { id: 'c' }]);
  });

  it('handles every subcollection and treats absent optional arrays as empty', () => {
    const doc: Document = { tables: [{ id: 0 }] };
    expect(
      diffDoc(doc, { tables: [{ id: 0, fields: [], indices: [], uniqueConstraints: [] }] }),
    ).toEqual([]);
    const result = applyOps(doc, [
      { t: 'sadd', coll: 'tables', id: 0, sub: 'indices', item: { id: 1, name: 'ix' }, index: 0 },
      {
        t: 'spatch',
        coll: 'tables',
        id: 0,
        sub: 'indices',
        sid: 1,
        patch: { id: 'bad', name: 'new' },
        unset: ['id'],
      },
      { t: 'sdel', coll: 'tables', id: 0, sub: 'uniqueConstraints', sid: 'missing' },
      { t: 'sdel', coll: 'tables', id: 0, sub: 'indices', sid: 1 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.doc).toEqual({ tables: [{ id: 0, indices: [] }] });
  });

  it('emits del/add/patch/suboperations/order with immutable identities', () => {
    const prev: Document = {
      tables: [
        { id: 'a', name: 'old', extra: true, fields: [{ id: 0 }] },
        { id: 'b' },
        { id: 'gone' },
      ],
    };
    const next: Document = {
      tables: [{ id: 'b' }, { id: 'new' }, { id: 'a', name: 'new', fields: [{ id: 1 }] }],
    };
    expect(diffDoc(prev, next)).toEqual([
      { t: 'del', coll: 'tables', id: 'gone' },
      { t: 'add', coll: 'tables', item: { id: 'new' }, index: 1 },
      { t: 'patch', coll: 'tables', id: 'a', patch: { name: 'new' }, unset: ['extra'] },
      { t: 'sdel', coll: 'tables', id: 'a', sub: 'fields', sid: 0 },
      { t: 'sadd', coll: 'tables', id: 'a', sub: 'fields', item: { id: 1 }, index: 0 },
      { t: 'order', coll: 'tables', ids: ['b', 'new', 'a'] },
    ]);
    expect(diffDoc(base(), { ...base(), pan: { x: 5 }, zoom: 2 })).toEqual([]);
  });

  it('roundtrips 200 seeded pairs with table, field, note and enum changes', () => {
    let seed = 173;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const vary = (items: Item[], prefix: string, round: number): Item[] => {
      let next = structuredClone(items);
      if (next.length && (next.length >= 6 || random() < 0.7))
        next.splice(Math.floor(random() * next.length), 1);
      next.splice(Math.floor(random() * (next.length + 1)), 0, {
        id: `${prefix}${round}`,
        name: `new${round}`,
      });
      for (const item of next) {
        if (random() < 0.6) item.name = `edited${round}`;
        if (random() < 0.3) delete item.name;
      }
      if (random() < 0.5) next = next.reverse();
      return next;
    };
    let prev = base();
    for (let i = 0; i < 200; i++) {
      const next = structuredClone(prev);
      next.database = i % 2 ? 'generic' : 'postgresql';
      next.sqlHeader = `-- ${i}`;
      next.tables = vary(next.tables!, 't', i);
      for (const table of next.tables) {
        table.fields = vary((table.fields ?? []) as Item[], `f${table.id}-`, i);
        table.indices = vary((table.indices ?? []) as Item[], `ix${table.id}-`, i);
        table.uniqueConstraints = vary(
          (table.uniqueConstraints ?? []) as Item[],
          `uc${table.id}-`,
          i,
        );
      }
      next.notes = vary(next.notes!, 'n', i);
      next.enums = vary(next.enums!, 'e', i);
      next.relationships = vary(next.relationships!, 'r', i);
      next.areas = vary(next.areas!, 'a', i);
      next.views = vary(next.views!, 'v', i);
      next.types = vary(next.types!, 'type', i);
      const ops = diffDoc(freezeDeep(prev), freezeDeep(next));
      expect(validateOps(ops), `valid operations at pair ${i}`).toEqual(ops);
      const result = applyOps(prev, ops);
      expect(result.ok, `accepted operations at pair ${i}`).toBe(true);
      expect(isEqual(result.doc, next), `roundtrip pair ${i}`).toBe(true);
      prev = next;
    }
  });
});

describe('operation validation', () => {
  it('accepts 5000 operations and preserves numeric and string ids', () => {
    const ops = Array.from({ length: 5000 }, (_, id) => ({ t: 'del', coll: 'notes', id }));
    expect(validateOps(ops)).toEqual(ops);
    expect(validateOps([...ops, ops[0]])).toBeNull();
    expect(validateOps([{ t: 'order', coll: 'notes', ids: [0, '0'] }])).toEqual([
      { t: 'order', coll: 'notes', ids: [0, '0'] },
    ]);
    expect(validateOps([])).toEqual([]);
  });

  it.each([
    null,
    {},
    [{ t: 'patch', coll: 'users', id: 'u', patch: {} }],
    [{ t: 'set', key: 'pan', value: {} }],
    [{ t: 'sdel', coll: 'notes', id: 0, sub: 'fields', sid: 0 }],
    [{ t: 'sdel', coll: 'tables', id: 0, sub: 'users', sid: 0 }],
    [{ t: 'del', coll: 'notes', id: null }],
    [{ t: 'add', coll: 'tables', item: { name: 'missing id' }, index: 0 }],
    [{ t: 'add', coll: 'tables', item: { id: 0 }, index: -1 }],
    [{ t: 'add', coll: 'tables', item: { id: 0 }, index: 0.5 }],
    [{ t: 'patch', coll: 'tables', id: 0, patch: [] }],
    [{ t: 'del', coll: 'notes', id: 0, extra: true }],
    [{ t: 'order', coll: 'notes', ids: [Infinity] }],
    [{ t: 'set', key: 'database', value: undefined }],
  ])('rejects malformed operations: %j', (input) => expect(validateOps(input)).toBeNull());

  it('accepts all supported database labels and string SQL headers only', () => {
    for (const value of [
      'mysql',
      'postgresql',
      'transactsql',
      'sqlite',
      'mariadb',
      'oraclesql',
      'generic',
    ]) {
      const ops = [{ t: 'set', key: 'database', value }];
      expect(validateOps(ops)).toEqual(ops);
    }
    for (const key of ['database', 'sqlHeader']) {
      for (const value of [null, false, 0, {}, []])
        expect(validateOps([{ t: 'set', key, value }])).toBeNull();
    }
    expect(validateOps([{ t: 'set', key: 'database', value: 'unsupported' }])).toBeNull();
    expect(validateOps([{ t: 'set', key: 'sqlHeader', value: '-- header' }])).toEqual([
      { t: 'set', key: 'sqlHeader', value: '-- header' },
    ]);
  });

  it('rejects malformed table subcollections before they can reach the reducer', () => {
    for (const sub of ['fields', 'indices', 'uniqueConstraints']) {
      for (const value of [
        null,
        'oops',
        {},
        [null],
        [1],
        [[]],
        [{ name: 'missing identity' }],
        [{ id: null }],
        [{ id: 0 }, { id: 0 }],
      ]) {
        expect(
          validateOps([{ t: 'add', coll: 'tables', item: { id: 't', [sub]: value }, index: 0 }]),
        ).toBeNull();
      }
      const ops = [
        { t: 'add', coll: 'tables', item: { id: 't', [sub]: [{ id: 0 }, { id: '0' }] }, index: 0 },
      ];
      expect(validateOps(ops)).toEqual(ops);
    }
  });

  it('rejects the duplicated deep patch payload reported in review before it can be persisted', () => {
    const nested = '{"x":'.repeat(3000) + '0' + '}'.repeat(3000);
    const patch = '{"t":"patch","coll":"notes","id":"n","patch":{"extra":' + nested + '}}';
    expect(validateOps(JSON.parse('[' + patch + ',' + patch + ']')) === null).toBe(true);
  });

  const nestedValue = (levels: number, arrays: boolean): unknown => {
    let value: unknown = 'leaf';
    for (let i = 0; i < levels; i++) value = arrays ? [value] : { nested: value };
    return value;
  };

  it.each([false, true])('rejects 3000-level metadata before reduction (arrays: %s)', (arrays) => {
    const ops = [{ t: 'patch', coll: 'notes', id: 0, patch: { extra: nestedValue(3000, arrays) } }];
    expect(validateOps(ops) === null).toBe(true);
  });

  it.each([false, true])(
    'accepts depth 64 and rejects depth 65 from the batch root (arrays: %s)',
    (arrays) => {
      // Batch -> operation -> patch -> extra starts at depth 3; the leaf adds 61 edges.
      const ops = [
        { t: 'patch', coll: 'notes', id: 0, patch: { extra: nestedValue(61, arrays) } },
        { t: 'patch', coll: 'notes', id: 0, patch: { extra: nestedValue(61, arrays) } },
      ];
      const validated = validateOps(ops);
      expect(validated).toEqual(ops);
      const result = applyOps({ notes: [{ id: 0 }] }, validated!);
      expect(result.ok).toBe(true);
      const reloaded = JSON.parse(JSON.stringify(result.doc)) as Document;
      expect(reloaded).toEqual(result.doc);
      expect(diffDoc(result.doc, reloaded)).toEqual([]);
      const tooDeep = [
        { t: 'patch', coll: 'notes', id: 0, patch: { extra: nestedValue(62, arrays) } },
      ];
      expect(validateOps(tooDeep) === null).toBe(true);
    },
  );

  it('rejects prototype keys at every depth and non-JSON values', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const patch = JSON.parse(`{"nested":{"${key}":{"polluted":true}}}`);
      expect(validateOps([{ t: 'patch', coll: 'tables', id: 't', patch }])).toBeNull();
      expect(
        validateOps([{ t: 'patch', coll: 'tables', id: 't', patch: {}, unset: [key] }]),
      ).toBeNull();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [() => true, new Date(), NaN, cyclic, Object.create({ polluted: true })]) {
      expect(validateOps([{ t: 'patch', coll: 'tables', id: 't', patch: { value } }])).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('awareness colors', () => {
  it.each([
    ['', '#2563eb'],
    ['a', '#dc2626'],
    ['user-1', '#4f46e5'],
    ['0192c78a-0000-7000-8000-000000000001', '#0891b2'],
    ['😀', '#4f46e5'],
  ])('uses the shared palette and unsigned hash for %s', (id, expected) => {
    expect(colorFor(id)).toBe(expected);
  });
});
