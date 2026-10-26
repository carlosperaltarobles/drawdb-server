import { AppError } from '../http/app-error';
import { entityKey, type DocumentIndex, type IndexedEntity } from './document-index';
import type { ContextPage, Scope, ScopeEntity } from './types';

export type ContextPart = 'catalog' | 'detail' | 'fields' | 'neighbors' | 'relevant';

export type ContextQuery = {
  query?: string;
  ids?: ScopeEntity[];
  cursor?: string;
  part?: ContextPart;
  limit?: number;
  direction?: 'in' | 'out' | 'both';
  scope?: Scope;
};

export type ContextBudget = {
  maxBytes?: number;
  maxTokens?: number;
  usedPromptTokens?: number;
  reserveOutputTokens?: number;
};

type CursorPayload = {
  v: number;
  h: string;
  p: ContextPart;
  q: string;
  s: string;
  d: string;
  o: number;
};

function scopeSignature(scope: Scope | undefined, ids: ScopeEntity[] | undefined): string {
  const parts: string[] = [];
  if (scope?.entities) {
    parts.push(
      'scope:' +
        scope.entities
          .map((e) => entityKey(e.coll, e.id))
          .sort()
          .join(','),
    );
  } else {
    parts.push('scope:all');
  }
  if (ids && ids.length > 0) {
    parts.push('ids:' + ids.map((e) => entityKey(e.coll, e.id)).join(','));
  }
  return parts.join('|');
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAndVerifyCursor(
  raw: string,
  expected: Omit<CursorPayload, 'o'>,
): number {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new AppError('invalid_input');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('invalid_input');
  }
  const c = parsed as Partial<CursorPayload>;
  if (
    c.v !== expected.v ||
    c.h !== expected.h ||
    c.p !== expected.p ||
    c.q !== expected.q ||
    c.s !== expected.s ||
    c.d !== expected.d ||
    typeof c.o !== 'number' ||
    !Number.isInteger(c.o) ||
    c.o < 0
  ) {
    throw new AppError('invalid_input');
  }
  return c.o;
}

function effectiveMaxBytes(budget: ContextBudget = {}): number {
  const hardCap = Math.min(budget.maxBytes ?? 200 * 1024, 200 * 1024);
  if (typeof budget.maxTokens === 'number' && budget.maxTokens > 0) {
    const used = budget.usedPromptTokens ?? 0;
    const reserve = budget.reserveOutputTokens ?? 0;
    const remainingTokens = Math.max(256, budget.maxTokens - used - reserve);
    return Math.min(hardCap, remainingTokens * 4);
  }
  return hardCap;
}

function toCatalogEntry(index: DocumentIndex, ent: IndexedEntity): Record<string, unknown> {
  const outEdges = index.outgoingByKey.get(ent.key) ?? [];
  const inEdges = index.incomingByKey.get(ent.key) ?? [];
  const base: Record<string, unknown> = {
    coll: ent.coll,
    id: ent.id,
    name: ent.name,
    outgoingCount: outEdges.length,
    incomingCount: inEdges.length,
  };
  if (ent.coll === 'tables') {
    const fields = Array.isArray(ent.item.fields) ? ent.item.fields : [];
    base.fieldCount = fields.length;
    base.relatedTables = [
      ...new Set(
        [...outEdges, ...inEdges]
          .filter((e) => e.to.coll === 'tables' && e.from.coll === 'tables')
          .map((e) => (e.from.id === ent.id ? e.to.id : e.from.id)),
      ),
    ].slice(0, 12);
  }
  return base;
}

function toBoundedDetailItem(
  ent: IndexedEntity,
  maxBytes: number,
): Record<string, unknown> {
  const fullJson = JSON.stringify({ coll: ent.coll, ...ent.item });
  if (Buffer.byteLength(fullJson, 'utf8') <= maxBytes) {
    return { coll: ent.coll, ...ent.item };
  }
  // Single huge entity: return table metadata and bounded initial fields slice with explicit flag
  if (ent.coll === 'tables' && Array.isArray(ent.item.fields)) {
    const allFields = ent.item.fields as Record<string, unknown>[];
    const fittingFields: Record<string, unknown>[] = [];
    let currentBytes = 512;
    for (const f of allFields) {
      const fBytes = Buffer.byteLength(JSON.stringify(f), 'utf8') + 2;
      if (currentBytes + fBytes > Math.max(1024, maxBytes - 512)) break;
      fittingFields.push(f);
      currentBytes += fBytes;
    }
    return {
      coll: 'tables',
      id: ent.id,
      name: ent.name,
      comment: ent.item.comment ?? '',
      color: ent.item.color ?? '#175e7a',
      fields: fittingFields,
      fieldsTruncated: fittingFields.length < allFields.length,
      totalFields: allFields.length,
      indicesCount: Array.isArray(ent.item.indices) ? ent.item.indices.length : 0,
    };
  }
  return {
    coll: ent.coll,
    id: ent.id,
    name: ent.name,
    truncated: true,
  };
}

export function queryContext(
  index: DocumentIndex,
  query: ContextQuery = {},
  budget: ContextBudget = {},
): ContextPage {
  const part: ContextPart = query.part ?? 'catalog';
  const limit = Math.max(1, Math.min(query.limit ?? 25, 100));
  const queryNorm = (query.query ?? '').trim().toLowerCase();
  const direction = query.direction ?? 'both';
  const scope: Scope = query.scope ?? { entities: null };
  const sig = scopeSignature(scope, query.ids);
  const maxBytes = effectiveMaxBytes(budget);

  const cursorMeta = {
    v: index.version,
    h: index.baseHash,
    p: part,
    q: queryNorm,
    s: sig,
    d: direction,
  };

  const offset = query.cursor ? decodeAndVerifyCursor(query.cursor, cursorMeta) : 0;

  if (part === 'fields') {
    const targetRef = query.ids?.[0] ?? scope.entities?.[0];
    if (!targetRef) throw new AppError('invalid_input');
    const target = index.entitiesByKey.get(entityKey(targetRef.coll, targetRef.id));
    if (!target) {
      return {
        items: [],
        nextCursor: null,
        scope,
        baseVersion: index.version,
        baseHash: index.baseHash,
        coverage: { reviewed: 0, remaining: 0 },
        bytes: 2,
      };
    }
    const allFields = Array.isArray(target.item.fields)
      ? (target.item.fields as Record<string, unknown>[])
      : [];
    const filteredFields = queryNorm
      ? allFields.filter(
          (f) =>
            (typeof f.name === 'string' && f.name.toLowerCase().includes(queryNorm)) ||
            (typeof f.type === 'string' && f.type.toLowerCase().includes(queryNorm)),
        )
      : allFields;

    const items: Record<string, unknown>[] = [];
    let bytes = 2;
    let i = offset;
    while (i < filteredFields.length && items.length < limit) {
      const fieldObj = { parentColl: target.coll, parentId: target.id, ...filteredFields[i] };
      const itemBytes = Buffer.byteLength(JSON.stringify(fieldObj), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > maxBytes) break;
      items.push(fieldObj);
      bytes += itemBytes;
      i++;
    }

    const reviewed = Math.min(i, filteredFields.length);
    const remaining = Math.max(0, filteredFields.length - reviewed);
    const nextCursor = remaining > 0 ? encodeCursor({ ...cursorMeta, o: i }) : null;

    return {
      items,
      nextCursor,
      scope,
      baseVersion: index.version,
      baseHash: index.baseHash,
      coverage: { reviewed, remaining },
      bytes,
    };
  }

  const candidates: IndexedEntity[] = [];
  const allowedKeys = scope.entities
    ? new Set(scope.entities.map((e) => entityKey(e.coll, e.id)))
    : null;

  if (part === 'neighbors') {
    const seeds = query.ids ?? scope.entities ?? [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const sKey = entityKey(seed.coll, seed.id);
      const edges = [
        ...(direction === 'out' || direction === 'both' ? (index.outgoingByKey.get(sKey) ?? []) : []),
        ...(direction === 'in' || direction === 'both' ? (index.incomingByKey.get(sKey) ?? []) : []),
      ];
      for (const edge of edges) {
        for (const endpoint of [edge.from, edge.to]) {
          const k = entityKey(endpoint.coll, endpoint.id);
          if (!seen.has(k)) {
            seen.add(k);
            const ent = index.entitiesByKey.get(k);
            if (ent) candidates.push(ent);
          }
        }
        if (edge.viaId !== undefined) {
          const relKey = entityKey('relationships', edge.viaId);
          if (!seen.has(relKey)) {
            seen.add(relKey);
            const relEnt = index.entitiesByKey.get(relKey);
            if (relEnt) candidates.push(relEnt);
          }
        }
      }
    }
  } else if (part === 'relevant') {
    const tokens = queryNorm
      .split(/[^a-z0-9_]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const scored: Array<{ ent: IndexedEntity; score: number }> = [];
    for (const ent of index.orderedEntities) {
      if (allowedKeys && !allowedKeys.has(ent.key)) continue;
      let score = 0;
      const lowerName = ent.name.toLowerCase();
      if (queryNorm && lowerName === queryNorm) score += 100;
      else if (queryNorm && lowerName.includes(queryNorm)) score += 50;
      for (const tok of tokens) {
        if (lowerName === tok) score += 40;
        else if (lowerName.includes(tok)) score += 20;
        if (ent.coll === 'tables' && index.tableFieldsByName.get(ent.key)?.has(tok)) {
          score += 15;
        }
      }
      if (score > 0 || tokens.length === 0) scored.push({ ent, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    for (const { ent } of scored) {
      if (!seen.has(ent.key)) {
        seen.add(ent.key);
        candidates.push(ent);
      }
      const edges = [
        ...(index.outgoingByKey.get(ent.key) ?? []),
        ...(index.incomingByKey.get(ent.key) ?? []),
      ];
      for (const edge of edges) {
        for (const ep of [edge.from, edge.to]) {
          const k = entityKey(ep.coll, ep.id);
          if (!seen.has(k)) {
            seen.add(k);
            const neighbor = index.entitiesByKey.get(k);
            if (neighbor) candidates.push(neighbor);
          }
        }
      }
    }
  } else if (query.ids && query.ids.length > 0) {
    for (const ref of query.ids) {
      const ent = index.entitiesByKey.get(entityKey(ref.coll, ref.id));
      if (ent && (!allowedKeys || allowedKeys.has(ent.key))) {
        candidates.push(ent);
      }
    }
  } else {
    for (const ent of index.orderedEntities) {
      if (allowedKeys && !allowedKeys.has(ent.key)) continue;
      if (queryNorm) {
        const nameMatch = ent.name.toLowerCase().includes(queryNorm);
        const fieldMatch =
          ent.coll === 'tables' &&
          Array.isArray(ent.item.fields) &&
          (ent.item.fields as Array<{ name?: unknown }>).some(
            (f) => typeof f.name === 'string' && f.name.toLowerCase().includes(queryNorm),
          );
        if (!nameMatch && !fieldMatch) continue;
      }
      candidates.push(ent);
    }
  }

  const items: Record<string, unknown>[] = [];
  let bytes = 2;
  let i = offset;
  while (i < candidates.length && items.length < limit) {
    const ent = candidates[i]!;
    const repr =
      part === 'catalog'
        ? toCatalogEntry(index, ent)
        : toBoundedDetailItem(ent, Math.max(1024, maxBytes - bytes));
    const itemBytes = Buffer.byteLength(JSON.stringify(repr), 'utf8') + 1;
    if (items.length > 0 && bytes + itemBytes > maxBytes) break;
    items.push(repr);
    bytes += itemBytes;
    i++;
  }

  const reviewed = Math.min(i, candidates.length);
  const remaining = Math.max(0, candidates.length - reviewed);
  const nextCursor = remaining > 0 ? encodeCursor({ ...cursorMeta, o: i }) : null;

  return {
    items,
    nextCursor,
    scope,
    baseVersion: index.version,
    baseHash: index.baseHash,
    coverage: { reviewed, remaining },
    bytes,
  };
}


