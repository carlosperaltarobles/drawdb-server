import { COLLS, type Document, type Op } from '../collab/ops';
import { BULK_DELETES, BULK_MIN_DELETES, BULK_TABLE_RATIO } from './constants';

// Relationships go along with every table delete, so counting them would turn deleting a single
// table into a "bulk delete" and burn the cooldown before a real one.
const COUNTED: ReadonlySet<string> = new Set(COLLS.filter((coll) => coll !== 'relationships'));

export function isBulkDelete(doc: Document, ops: readonly Op[]): boolean {
  let deletes = 0;
  let tableDeletes = 0;

  for (const op of ops) {
    if (op.t !== 'del' || !COUNTED.has(op.coll)) continue;
    if (!doc[op.coll]?.some((item) => item.id === op.id)) continue;
    deletes++;
    if (op.coll === 'tables') tableDeletes++;
  }

  const totalTables = Math.max(1, doc.tables?.length ?? 0);
  return (
    deletes >= BULK_MIN_DELETES &&
    (deletes >= BULK_DELETES || tableDeletes / totalTables >= BULK_TABLE_RATIO)
  );
}
