import { describe, expect, it } from 'vitest';
import { summarizeChanges } from '../../src/ai/change-summary';
import type { Document } from '../../src/collab/ops';
import { EMPTY_DOC } from '../../src/projects/empty-doc';

describe('ChangeSummary calculation', () => {
  it('computes accurate counts and item details for added, modified, and removed entities and sub-elements', () => {
    const before: Document = {
      ...EMPTY_DOC,
      database: 'postgresql',
      tables: [
        {
          id: 1,
          name: 'users',
          x: 0,
          y: 0,
          comment: 'Old comment',
          color: '#175e7a',
          indices: [],
          uniqueConstraints: [],
          fields: [
            {
              id: 11,
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
              id: 12,
              name: 'legacy_code',
              type: 'VARCHAR',
              default: '',
              check: '',
              primary: false,
              unique: false,
              notNull: false,
              increment: false,
              comment: '',
            },
          ],
        },
      ],
      notes: [
        {
          id: 'note_old',
          title: 'To Remove',
          content: 'Bye',
          x: 0,
          y: 0,
          height: 100,
          color: '#fcf7ac',
        },
      ],
    };

    const after: Document = {
      ...EMPTY_DOC,
      database: 'postgresql',
      tables: [
        {
          id: 1,
          name: 'customers',
          x: 0,
          y: 0,
          comment: 'Updated comment',
          color: '#175e7a',
          indices: [],
          uniqueConstraints: [],
          fields: [
            {
              id: 11,
              name: 'id',
              type: 'BIGINT',
              default: '',
              check: '',
              primary: true,
              unique: true,
              notNull: true,
              increment: true,
              comment: '',
            },
            {
              id: 'f_new',
              name: 'created_at',
              type: 'TIMESTAMPTZ',
              default: '',
              check: '',
              primary: false,
              unique: false,
              notNull: true,
              increment: false,
              comment: '',
            },
          ],
        },
      ],
      notes: [
        {
          id: 'note_new',
          title: 'Review',
          content: 'Added note',
          x: 10,
          y: 20,
          height: 120,
          color: '#fcf7ac',
        },
      ],
    };

    const summary = summarizeChanges(before, after);
    expect(summary.counts.added).toBe(2); // f_new, note_new
    expect(summary.counts.modified).toBe(2); // table 1, field 11
    expect(summary.counts.removed).toBe(2); // field 12, note_old

    const tableItem = summary.items.find((i) => i.coll === 'tables' && i.id === 1 && !i.parentId);
    expect(tableItem).toEqual({
      coll: 'tables',
      id: 1,
      change: 'modified',
      beforeName: 'users',
      afterName: 'customers',
      properties: expect.arrayContaining(['name', 'comment']),
    });

    const addedField = summary.items.find((i) => i.id === 'f_new');
    expect(addedField).toMatchObject({
      coll: 'tables',
      id: 'f_new',
      parentId: 1,
      change: 'added',
      afterName: 'created_at',
    });

    const removedField = summary.items.find((i) => i.id === 12);
    expect(removedField).toMatchObject({
      coll: 'tables',
      id: 12,
      parentId: 1,
      change: 'removed',
      beforeName: 'legacy_code',
    });
  });
});
