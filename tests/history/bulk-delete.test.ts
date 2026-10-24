import { describe, expect, it } from 'vitest';
import type { Document, Item, Op } from '../../src/collab/ops';
import { isBulkDelete } from '../../src/history/bulk-delete';
import { EMPTY_DOC } from '../../src/projects/empty-doc';

function makeTables(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: `table_${i + 1}`,
    fields: [],
  }));
}

function docWithTables(count: number): Document {
  return {
    ...EMPTY_DOC,
    tables: makeTables(count),
  };
}

describe('isBulkDelete', () => {
  it('devuelve false con 1 del', () => {
    const doc = docWithTables(2);
    const ops: Op[] = [{ t: 'del', coll: 'tables', id: 't1' }];
    expect(isBulkDelete(doc, ops)).toBe(false);
  });

  it('devuelve false con 2 del de 10 tablas (20 % < 30 %)', () => {
    const doc = docWithTables(10);
    const ops: Op[] = [
      { t: 'del', coll: 'tables', id: 't1' },
      { t: 'del', coll: 'tables', id: 't2' },
    ];
    expect(isBulkDelete(doc, ops)).toBe(false);
  });

  it('devuelve true con 2 del de tablas en un doc con 6 tablas (33 % >= 30 %)', () => {
    const doc = docWithTables(6);
    const ops: Op[] = [
      { t: 'del', coll: 'tables', id: 't1' },
      { t: 'del', coll: 'tables', id: 't2' },
    ];
    expect(isBulkDelete(doc, ops)).toBe(true);
  });

  it('devuelve true con 5 del de notas', () => {
    const doc: Document = {
      ...EMPTY_DOC,
      notes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i + 1}`, content: `Note ${i + 1}` })),
    };
    const ops: Op[] = [
      { t: 'del', coll: 'notes', id: 'n1' },
      { t: 'del', coll: 'notes', id: 'n2' },
      { t: 'del', coll: 'notes', id: 'n3' },
      { t: 'del', coll: 'notes', id: 'n4' },
      { t: 'del', coll: 'notes', id: 'n5' },
    ];
    expect(isBulkDelete(doc, ops)).toBe(true);
  });

  it('devuelve false con 4 sdel (no cuentan como borrado de entidad de primer nivel)', () => {
    const doc = docWithTables(2);
    const ops: Op[] = [
      { t: 'sdel', coll: 'tables', id: 't1', sub: 'fields', sid: 'f1' },
      { t: 'sdel', coll: 'tables', id: 't1', sub: 'fields', sid: 'f2' },
      { t: 'sdel', coll: 'tables', id: 't1', sub: 'fields', sid: 'f3' },
      { t: 'sdel', coll: 'tables', id: 't1', sub: 'fields', sid: 'f4' },
      { t: 'sdel', coll: 'tables', id: 't1', sub: 'fields', sid: 'f5' },
    ];
    expect(isBulkDelete(doc, ops)).toBe(false);
  });

  it('borrar una tabla con sus relaciones no cuenta como borrado masivo', () => {
    const doc: Document = {
      ...docWithTables(10),
      relationships: Array.from({ length: 4 }, (_, i) => ({ id: `r${i + 1}` })),
    };
    const ops: Op[] = [
      { t: 'del', coll: 'tables', id: 't1' },
      { t: 'del', coll: 'relationships', id: 'r1' },
      { t: 'del', coll: 'relationships', id: 'r2' },
      { t: 'del', coll: 'relationships', id: 'r3' },
      { t: 'del', coll: 'relationships', id: 'r4' },
    ];
    expect(isBulkDelete(doc, ops)).toBe(false);
  });

  it('no cuenta borrados de ids que ya no existen', () => {
    const doc = docWithTables(10);
    const ops: Op[] = ['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => ({
      t: 'del' as const,
      coll: 'tables' as const,
      id,
    }));
    expect(isBulkDelete(doc, ops)).toBe(false);
  });
});
