import isEqual from 'lodash/isEqual';
import { COLLS, SUBS, type Coll, type Document, type Item } from '../collab/ops';
import { idKey } from './document-index';
import type { ChangeSummary, ChangeSummaryItem } from './types';

function itemName(coll: Coll, item: Item): string | undefined {
  if (coll === 'notes') {
    return typeof item.title === 'string' ? item.title : undefined;
  }
  return typeof item.name === 'string' ? item.name : undefined;
}

function changedProps(
  prev: Item,
  next: Item,
  exclude: ReadonlySet<string>,
): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const props: string[] = [];
  for (const k of keys) {
    if (exclude.has(k)) continue;
    if (!isEqual(prev[k], next[k])) {
      props.push(k);
    }
  }
  return props;
}

export function summarizeChanges(before: Document, after: Document): ChangeSummary {
  const items: ChangeSummaryItem[] = [];
  let added = 0;
  let modified = 0;
  let removed = 0;

  for (const coll of COLLS) {
    const prevList = Array.isArray(before[coll]) ? (before[coll] as Item[]) : [];
    const nextList = Array.isArray(after[coll]) ? (after[coll] as Item[]) : [];
    if (prevList === nextList) continue;
    const prevByKey = new Map(prevList.map((it) => [idKey(it.id), it]));
    const nextByKey = new Map(nextList.map((it) => [idKey(it.id), it]));

    for (const prev of prevList) {
      if (!nextByKey.has(idKey(prev.id))) {
        removed++;
        const beforeName = itemName(coll, prev);
        items.push({
          coll,
          id: prev.id,
          change: 'removed',
          ...(beforeName !== undefined ? { beforeName } : {}),
          properties: Object.keys(prev).filter((k) => k !== 'id'),
        });
      }
    }

    for (const next of nextList) {
      const k = idKey(next.id);
      const prev = prevByKey.get(k);
      if (!prev) {
        added++;
        const afterName = itemName(coll, next);
        items.push({
          coll,
          id: next.id,
          change: 'added',
          ...(afterName !== undefined ? { afterName } : {}),
          properties: Object.keys(next).filter((key) => key !== 'id'),
        });
        continue;
      }
      if (prev === next) continue;


      if (coll === 'tables') {
        const tableExclude = new Set<string>(['id', ...SUBS.tables]);
        const scalarProps = changedProps(prev, next, tableExclude);
        if (scalarProps.length > 0) {
          modified++;
          const beforeName = itemName(coll, prev);
          const afterName = itemName(coll, next);
          items.push({
            coll: 'tables',
            id: next.id,
            change: 'modified',
            ...(beforeName !== undefined ? { beforeName } : {}),
            ...(afterName !== undefined ? { afterName } : {}),
            properties: scalarProps,
          });
        }

        // Summarize sub-collections (fields, indices, uniqueConstraints)
        for (const sub of SUBS.tables) {
          const prevSub = Array.isArray(prev[sub]) ? (prev[sub] as Item[]) : [];
          const nextSub = Array.isArray(next[sub]) ? (next[sub] as Item[]) : [];
          if (prevSub === nextSub) continue;
          const prevSubByKey = new Map(prevSub.map((s) => [idKey(s.id), s]));
          const nextSubByKey = new Map(nextSub.map((s) => [idKey(s.id), s]));

          for (const ps of prevSub) {
            if (!nextSubByKey.has(idKey(ps.id))) {
              removed++;
              const bName = typeof ps.name === 'string' ? ps.name : undefined;
              items.push({
                coll: 'tables',
                id: ps.id,
                parentId: next.id,
                change: 'removed',
                ...(bName !== undefined ? { beforeName: bName } : {}),
                properties: Object.keys(ps).filter((key) => key !== 'id'),
              });
            }
          }

          for (const ns of nextSub) {
            const ps = prevSubByKey.get(idKey(ns.id));
            if (!ps) {
              added++;
              const aName = typeof ns.name === 'string' ? ns.name : undefined;
              items.push({
                coll: 'tables',
                id: ns.id,
                parentId: next.id,
                change: 'added',
                ...(aName !== undefined ? { afterName: aName } : {}),
                properties: Object.keys(ns).filter((key) => key !== 'id'),
              });
              continue;
            }
            if (ps === ns) continue;
            const subProps = changedProps(ps, ns, new Set(['id']));

            if (subProps.length > 0) {
              modified++;
              const bName = typeof ps.name === 'string' ? ps.name : undefined;
              const aName = typeof ns.name === 'string' ? ns.name : undefined;
              items.push({
                coll: 'tables',
                id: ns.id,
                parentId: next.id,
                change: 'modified',
                ...(bName !== undefined ? { beforeName: bName } : {}),
                ...(aName !== undefined ? { afterName: aName } : {}),
                properties: subProps,
              });
            }
          }
        }
      } else {
        const props = changedProps(prev, next, new Set(['id']));
        if (props.length > 0) {
          modified++;
          const beforeName = itemName(coll, prev);
          const afterName = itemName(coll, next);
          items.push({
            coll,
            id: next.id,
            change: 'modified',
            ...(beforeName !== undefined ? { beforeName } : {}),
            ...(afterName !== undefined ? { afterName } : {}),
            properties: props,
          });
        }
      }
    }
  }

  return {
    counts: { added, modified, removed },
    items,
  };
}
