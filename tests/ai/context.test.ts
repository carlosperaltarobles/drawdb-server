import { describe, expect, it } from 'vitest';
import { queryContext } from '../../src/ai/context';
import { hashDocument, indexDocument } from '../../src/ai/document-index';
import type { Document } from '../../src/collab/ops';
import { EMPTY_DOC } from '../../src/projects/empty-doc';

function buildLargeDoc(tableCount: number, fieldsPerTable = 20, extraCommentLen = 0): Document {
  const tables = [];
  const relationships = [];
  const pad = extraCommentLen > 0 ? 'x'.repeat(extraCommentLen) : '';
  for (let i = 0; i < tableCount; i++) {
    const tid = i % 2 === 0 ? i + 1 : `tbl_${i + 1}`;
    const fields = [];
    for (let f = 0; f < fieldsPerTable; f++) {
      const fid = f === 0 ? i * 100 + 1 : `fld_${i + 1}_${f + 1}`;
      fields.push({
        id: fid,
        name: f === 0 ? 'id' : f === 1 ? 'parent_id' : `col_${f + 1}`,
        type: f <= 1 ? 'INTEGER' : 'VARCHAR',
        default: '',
        check: '',
        primary: f === 0,
        unique: f === 0,
        notNull: f <= 1,
        increment: f === 0,
        comment: pad ? `field_${i}_${f}_${pad}` : '',
        ...(f > 1 ? { size: 255 } : {}),
      });
    }
    tables.push({
      id: tid,
      name: `table_${String(i + 1).padStart(4, '0')}`,
      x: (i % 25) * 300,
      y: Math.floor(i / 25) * 300,
      fields,
      comment: pad ? `table_${i}_${pad}` : `Table ${i + 1}`,
      indices: [{ id: `idx_${i + 1}`, name: `idx_table_${i + 1}`, unique: false, fields: ['id'] }],
      uniqueConstraints: [],
      color: '#175e7a',
    });
    if (i > 0) {
      const prevTable = tables[i - 1]!;
      relationships.push({
        id: `rel_${i}`,
        name: `fk_${i}`,
        startTableId: tid,
        startFieldId: fields[1]!.id,
        endTableId: prevTable.id,
        endFieldId: prevTable.fields[0]!.id,
        cardinality: 'many_to_one',
        updateConstraint: 'No action',
        deleteConstraint: 'Cascade',
      });
    }
  }
  return {
    ...EMPTY_DOC,
    database: 'postgresql',
    tables,
    relationships,
  };
}

describe('Document indexing, canonical hash, and paged context retrieval', () => {
  it('preserves numeric vs string IDs in canonical hashDocument', () => {
    const docNumeric: Document = {
      ...EMPTY_DOC,
      tables: [{ id: 1, name: 'users', x: 0, y: 0, fields: [], comment: '', indices: [], color: '#175e7a' }],
    };
    const docString: Document = {
      ...EMPTY_DOC,
      tables: [{ id: '1', name: 'users', x: 0, y: 0, fields: [], comment: '', indices: [], color: '#175e7a' }],
    };
    expect(hashDocument(docNumeric)).not.toBe(hashDocument(docString));
  });

  it('paginates 1,000 tables and catalogs exceeding 200 KiB with explicit coverage and cursor validation', () => {
    const doc = buildLargeDoc(1000, 20, 40);
    const idx = indexDocument(doc, 7);

    const page1 = queryContext(idx, { part: 'catalog', limit: 25 }, { maxBytes: 200 * 1024 });
    expect(page1.items.length).toBe(25);
    expect(page1.baseVersion).toBe(7);
    expect(page1.baseHash).toBe(idx.baseHash);
    expect(page1.coverage.reviewed).toBe(25);
    expect(page1.coverage.remaining).toBeGreaterThan(975);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.bytes).toBeLessThanOrEqual(200 * 1024);

    const page2 = queryContext(
      idx,
      { part: 'catalog', cursor: page1.nextCursor!, limit: 25 },
      { maxBytes: 200 * 1024 },
    );
    expect(page2.items.length).toBe(25);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    expect(page2.coverage.reviewed).toBe(50);

    // Cursor bound to version/query: using cursor on a different version or query must fail
    const idxNewVersion = indexDocument(doc, 8);
    expect(() =>
      queryContext(idxNewVersion, { part: 'catalog', cursor: page1.nextCursor! }, { maxBytes: 200 * 1024 }),
    ).toThrow();
    expect(() =>
      queryContext(
        idx,
        { part: 'catalog', query: 'table_0500', cursor: page1.nextCursor! },
        { maxBytes: 200 * 1024 },
      ),
    ).toThrow();
  });

  it('paginates a single huge entity by fields and dependencies without exceeding budget', () => {
    const hugeFields = Array.from({ length: 120 }, (_, i) => ({
      id: `f_${i + 1}`,
      name: `column_${i + 1}`,
      type: 'VARCHAR',
      default: '',
      check: '',
      primary: i === 0,
      unique: false,
      notNull: true,
      increment: false,
      comment: 'c'.repeat(500),
      size: 255,
    }));
    const doc: Document = {
      ...EMPTY_DOC,
      database: 'postgresql',
      tables: [
        {
          id: 'huge_table',
          name: 'huge_events',
          x: 0,
          y: 0,
          fields: hugeFields,
          comment: 'Huge table',
          indices: [],
          uniqueConstraints: [],
          color: '#175e7a',
        },
      ],
    };

    const idx = indexDocument(doc, 1);
    const budget = { maxBytes: 16 * 1024, maxTokens: 4000 };
    const firstSlice = queryContext(
      idx,
      { part: 'fields', ids: [{ coll: 'tables', id: 'huge_table' }], limit: 20 },
      budget,
    );
    expect(firstSlice.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(firstSlice.items.length).toBeGreaterThan(0);
    expect(firstSlice.items.length).toBeLessThanOrEqual(20);
    expect(firstSlice.nextCursor).toBeTruthy();

    const secondSlice = queryContext(
      idx,
      {
        part: 'fields',
        ids: [{ coll: 'tables', id: 'huge_table' }],
        cursor: firstSlice.nextCursor!,
        limit: 20,
      },
      budget,
    );
    expect(secondSlice.items.length).toBeGreaterThan(0);
    expect(secondSlice.items[0]?.id).not.toBe(firstSlice.items[0]?.id);
  });
});
