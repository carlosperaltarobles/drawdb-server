import { COLLS, type Document, type Op } from '../collab/ops';
import { BULK_DELETES, BULK_MIN_DELETES, BULK_TABLE_RATIO } from './constants';

const COLL_SET: ReadonlySet<string> = new Set(COLLS);

export function isBulkDelete(doc: Document, ops: readonly Op[]): boolean {
  let deletes = 0;
  let tableDeletes = 0;

  for (const op of ops) {
    if (op.t === 'del' && COLL_SET.has(op.coll)) {
      deletes++;
      if (op.coll === 'tables') {
        tableDeletes++;
      }
    }
  }

  const totalTables = Math.max(1, doc.tables?.length ?? 0);
  return (
    deletes >= BULK_MIN_DELETES &&
    (deletes >= BULK_DELETES || tableDeletes / totalTables >= BULK_TABLE_RATIO)
  );
}
