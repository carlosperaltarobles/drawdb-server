// Mantener sincronizado con FE/src/collab/ops.js.
import isEqual from 'lodash/isEqual';
export const COLLS = [
  'tables',
  'relationships',
  'notes',
  'areas',
  'views',
  'enums',
  'types',
] as const;
export const SUBS = { tables: ['fields', 'indices', 'uniqueConstraints'] as const };
export type Coll = (typeof COLLS)[number];
export type Sub = (typeof SUBS.tables)[number];
export type Id = string | number;
export interface Item {
  id: Id;
  [key: string]: unknown;
}
export type Document = Partial<Record<Coll, Item[]>> & {
  database?: unknown;
  sqlHeader?: unknown;
  [key: string]: unknown;
};
type Patch = { patch: Record<string, unknown>; unset?: string[] };
type ListOp =
  | { t: 'add'; item: Item; index: number }
  | { t: 'del'; id: Id }
  | ({ t: 'patch'; id: Id } & Patch)
  | { t: 'order'; ids: Id[] };
type NestedScope = { coll: 'tables'; id: Id; sub: Sub };
export type Op =
  | { t: 'set'; key: 'database' | 'sqlHeader'; value: unknown }
  | (ListOp & { coll: Coll })
  | ({ t: 'sadd'; item: Item; index: number } & NestedScope)
  | ({ t: 'sdel'; sid: Id } & NestedScope)
  | ({ t: 'spatch'; sid: Id } & NestedScope & Patch)
  | ({ t: 'sorder'; ids: Id[] } & NestedScope);

function patchItem(item: Item, patch: Patch, protectedKeys: readonly string[] = []): Item {
  const result = { ...item };
  const protectedSet = new Set(['id', ...protectedKeys]);
  for (const [key, value] of Object.entries(patch.patch)) {
    if (!protectedSet.has(key))
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  for (const key of patch.unset ?? []) if (!protectedSet.has(key)) delete result[key];
  return isEqual(result, item) ? item : result;
}

function changeList(
  items: Item[],
  op: ListOp,
  protectedKeys: readonly string[] = [],
): { items: Item[]; ok: boolean } {
  if (op.t === 'add') {
    if (items.some((item) => item.id === op.item.id)) return { items, ok: true };
    const next = [...items];
    next.splice(Math.max(0, Math.min(op.index, next.length)), 0, op.item);
    return { items: next, ok: true };
  }
  if (op.t === 'order') {
    const byId = new Map(items.map((item) => [item.id, item]));
    const next: Item[] = [];
    for (const id of op.ids) {
      const item = byId.get(id);
      if (item) {
        next.push(item);
        byId.delete(id);
      }
    }
    next.push(...items.filter((item) => byId.has(item.id)));
    return { items: next.every((item, i) => item === items[i]) ? items : next, ok: true };
  }
  const index = items.findIndex((item) => item.id === op.id);
  if (index < 0) return { items, ok: op.t === 'del' };
  if (op.t === 'del') return { items: items.filter((_, i) => i !== index), ok: true };
  const item = patchItem(items[index], op, protectedKeys);
  if (item === items[index]) return { items, ok: true };
  const next = [...items];
  next[index] = item;
  return { items: next, ok: true };
}

function nestedListOp(op: Extract<Op, NestedScope>): ListOp {
  switch (op.t) {
    case 'sadd':
      return { t: 'add', item: op.item, index: op.index };
    case 'sdel':
      return { t: 'del', id: op.sid };
    case 'spatch':
      return { t: 'patch', id: op.sid, patch: op.patch, unset: op.unset };
    case 'sorder':
      return { t: 'order', ids: op.ids };
  }
}

export function applyOp(doc: Document, op: Op): { doc: Document; ok: boolean } {
  if (op.t === 'set') {
    if (!['database', 'sqlHeader'].includes(op.key)) return { doc, ok: false };
    return { doc: isEqual(doc[op.key], op.value) ? doc : { ...doc, [op.key]: op.value }, ok: true };
  }
  if (!COLLS.includes(op.coll)) return { doc, ok: false };
  const items = doc[op.coll] ?? [];
  if ('sub' in op) {
    if (op.coll !== 'tables' || !SUBS.tables.includes(op.sub)) return { doc, ok: false };
    const index = items.findIndex((item) => item.id === op.id);
    if (index < 0) return { doc, ok: false };
    const previous = (items[index][op.sub] ?? []) as Item[];
    const result = changeList(previous, nestedListOp(op));
    if (result.items === previous) return { doc, ok: result.ok };
    const next = [...items];
    next[index] = { ...items[index], [op.sub]: result.items };
    return { doc: { ...doc, [op.coll]: next }, ok: result.ok };
  }
  const result = changeList(items, op, op.coll === 'tables' ? SUBS.tables : []);
  return { doc: result.items === items ? doc : { ...doc, [op.coll]: result.items }, ok: result.ok };
}

export function applyOps(
  doc: Document,
  ops: readonly Op[],
): { doc: Document; applied: Op[]; ok: boolean } {
  let next = doc;
  let ok = true;
  const applied: Op[] = [];
  for (const op of ops) {
    const result = applyOp(next, op);
    next = result.doc;
    if (result.ok) applied.push(op);
    else ok = false;
  }
  return { doc: next, applied, ok };
}

function diffPatch(prev: Item, next: Item, excluded: readonly string[]): Patch {
  const patch: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of Object.keys(next)) {
    if (!excluded.includes(key) && !isEqual(prev[key], next[key])) {
      Object.defineProperty(patch, key, {
        value: next[key],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  for (const key of Object.keys(prev)) {
    if (!excluded.includes(key) && !Object.prototype.hasOwnProperty.call(next, key))
      unset.push(key);
  }
  return { patch, ...(unset.length ? { unset } : {}) };
}

type Scope = { coll: Coll } | NestedScope;
function scopedOp(scope: Scope, op: ListOp): Op {
  if (!('sub' in scope)) return { ...op, ...scope };
  switch (op.t) {
    case 'add':
      return { t: 'sadd', ...scope, item: op.item, index: op.index };
    case 'del':
      return { t: 'sdel', ...scope, sid: op.id };
    case 'patch':
      return {
        t: 'spatch',
        ...scope,
        sid: op.id,
        patch: op.patch,
        ...(op.unset ? { unset: op.unset } : {}),
      };
    case 'order':
      return { t: 'sorder', ...scope, ids: op.ids };
  }
}

function diffList(prev: Item[] = [], next: Item[] = [], scope: Scope, ops: Op[]): void {
  if (prev === next || isEqual(prev, next)) return;
  const before = new Map(prev.map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  for (const item of prev)
    if (!after.has(item.id)) ops.push(scopedOp(scope, { t: 'del', id: item.id }));
  next.forEach((item, index) => {
    if (!before.has(item.id)) ops.push(scopedOp(scope, { t: 'add', item, index }));
  });
  for (const item of next) {
    const previous = before.get(item.id);
    if (!previous || previous === item || isEqual(previous, item)) continue;
    const subs = !('sub' in scope) && scope.coll === 'tables' ? SUBS.tables : [];
    const delta = diffPatch(previous, item, ['id', ...subs]);
    if (Object.keys(delta.patch).length || delta.unset?.length)
      ops.push(scopedOp(scope, { t: 'patch', id: item.id, ...delta }));
    for (const sub of subs)
      diffList(
        previous[sub] as Item[] | undefined,
        item[sub] as Item[] | undefined,
        { coll: 'tables', id: item.id, sub },
        ops,
      );
  }
  const prevCommon = prev.filter((item) => after.has(item.id)).map((item) => item.id);
  const nextCommon = next.filter((item) => before.has(item.id)).map((item) => item.id);
  if (!isEqual(prevCommon, nextCommon))
    ops.push(scopedOp(scope, { t: 'order', ids: next.map((item) => item.id) }));
}

export function diffDoc(prev: Document, next: Document): Op[] {
  if (prev === next) return [];
  const ops: Op[] = [];
  for (const key of ['database', 'sqlHeader'] as const)
    if (!isEqual(prev[key], next[key])) ops.push({ t: 'set', key, value: next[key] });
  for (const coll of COLLS) diffList(prev[coll], next[coll], { coll }, ops);
  return ops;
}
