import { createHash } from 'node:crypto';
import { COLLS, type Coll, type Document, type Id, type Item } from '../collab/ops';


export function idKey(id: Id): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

export function entityKey(coll: Coll, id: Id): string {
  return `${coll}:${idKey(id)}`;
}

export type IndexedEntity = {
  coll: Coll;
  id: Id;
  key: string;
  name: string;
  item: Item;
};

export type ReferenceEdge = {
  from: { coll: Coll; id: Id };
  to: { coll: Coll; id: Id };
  kind:
    | 'relationship'
    | 'view_base'
    | 'view_join'
    | 'view_column'
    | 'view_condition'
    | 'inheritance'
    | 'field_type';
  viaId?: Id;
  fieldId?: Id;
  targetFieldId?: Id;
};

export type DocumentIndex = {
  doc: Document;
  version: number;
  baseHash: string;
  database: string;
  entitiesByKey: Map<string, IndexedEntity>;
  orderedEntities: IndexedEntity[];
  tableByName: Map<string, IndexedEntity>;
  tableFieldsByKey: Map<string, Map<string, Item>>;
  tableFieldsByName: Map<string, Map<string, Item>>;
  outgoingByKey: Map<string, ReferenceEdge[]>;
  incomingByKey: Map<string, ReferenceEdge[]>;
};

export function hashDocument(doc: Document): string {
  const hash = createHash('sha256');
  const chunks: string[] = [];
  let bufferedLen = 0;

  const push = (str: string) => {
    chunks.push(str);
    bufferedLen += str.length;
    if (bufferedLen >= 65536) {
      hash.update(chunks.join(''));
      chunks.length = 0;
      bufferedLen = 0;
    }
  };

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) {
      push('null');
      return;
    }
    if (typeof value === 'boolean') {
      push(value ? 'true' : 'false');
      return;
    }
    if (typeof value === 'number') {
      push(`n:${Number.isFinite(value) ? value : 'null'}`);
      return;
    }
    if (typeof value === 'string') {
      push(`s:${JSON.stringify(value)}`);
      return;
    }
    if (Array.isArray(value)) {
      push('[');
      for (let i = 0; i < value.length; i++) {
        if (i > 0) push(',');
        walk(value[i]);
      }
      push(']');
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      push('{');
      let first = true;
      for (const k of keys) {
        if (obj[k] === undefined) continue;
        if (!first) push(',');
        first = false;
        push(`${JSON.stringify(k)}:`);
        walk(obj[k]);
      }
      push('}');
    }
  };

  const canonicalRoot: Record<string, unknown> = {
    database: typeof doc.database === 'string' ? doc.database : 'generic',
    sqlHeader: typeof doc.sqlHeader === 'string' ? doc.sqlHeader : '',
  };
  for (const coll of COLLS) {
    canonicalRoot[coll] = Array.isArray(doc[coll]) ? doc[coll] : [];
  }
  walk(canonicalRoot);
  if (chunks.length > 0) {
    hash.update(chunks.join(''));
  }
  return hash.digest('hex');
}


function getEntityName(coll: Coll, item: Item): string {
  if (coll === 'notes') {
    return typeof item.title === 'string' ? item.title : String(item.id);
  }
  return typeof item.name === 'string' ? item.name : String(item.id);
}

export function indexDocument(doc: Document, version = 0): DocumentIndex {
  const baseHash = hashDocument(doc);
  const database = typeof doc.database === 'string' ? doc.database : 'generic';
  const entitiesByKey = new Map<string, IndexedEntity>();
  const orderedEntities: IndexedEntity[] = [];
  const tableByName = new Map<string, IndexedEntity>();
  const tableFieldsByKey = new Map<string, Map<string, Item>>();
  const tableFieldsByName = new Map<string, Map<string, Item>>();
  const outgoingByKey = new Map<string, ReferenceEdge[]>();
  const incomingByKey = new Map<string, ReferenceEdge[]>();

  const addEdge = (edge: ReferenceEdge) => {
    const fromKey = entityKey(edge.from.coll, edge.from.id);
    const toKey = entityKey(edge.to.coll, edge.to.id);
    let outList = outgoingByKey.get(fromKey);
    if (!outList) {
      outList = [];
      outgoingByKey.set(fromKey, outList);
    }
    outList.push(edge);

    let inList = incomingByKey.get(toKey);
    if (!inList) {
      inList = [];
      incomingByKey.set(toKey, inList);
    }
    inList.push(edge);
  };

  for (const coll of COLLS) {
    const list = Array.isArray(doc[coll]) ? (doc[coll] as Item[]) : [];
    for (const item of list) {
      if (!item || (typeof item.id !== 'string' && typeof item.id !== 'number')) continue;
      const key = entityKey(coll, item.id);
      const name = getEntityName(coll, item);
      const indexed: IndexedEntity = { coll, id: item.id, key, name, item };
      entitiesByKey.set(key, indexed);
      orderedEntities.push(indexed);

      if (coll === 'tables') {
        if (name) tableByName.set(name.toLowerCase(), indexed);
        const byFieldKey = new Map<string, Item>();
        const byFieldName = new Map<string, Item>();
        for (const f of (Array.isArray(item.fields) ? item.fields : []) as Item[]) {
          if (!f || (typeof f.id !== 'string' && typeof f.id !== 'number')) continue;
          byFieldKey.set(idKey(f.id), f);
          if (typeof f.name === 'string' && f.name) byFieldName.set(f.name.toLowerCase(), f);
        }
        tableFieldsByKey.set(key, byFieldKey);
        tableFieldsByName.set(key, byFieldName);
      }
    }
  }

  const customTypeByName = new Map<string, IndexedEntity>();
  for (const t of doc.types ?? []) {
    if (typeof t?.name === 'string') {
      const ent = entitiesByKey.get(entityKey('types', t.id));
      if (ent) customTypeByName.set(t.name.toLowerCase(), ent);
    }
  }
  const enumByName = new Map<string, IndexedEntity>();
  for (const e of doc.enums ?? []) {
    if (typeof e?.name === 'string') {
      const ent = entitiesByKey.get(entityKey('enums', e.id));
      if (ent) enumByName.set(e.name.toLowerCase(), ent);
    }
  }

  for (const rel of doc.relationships ?? []) {
    const startTableId = rel.startTableId as Id | undefined;
    const endTableId = rel.endTableId as Id | undefined;
    if (
      (typeof startTableId === 'string' || typeof startTableId === 'number') &&
      (typeof endTableId === 'string' || typeof endTableId === 'number')
    ) {
      addEdge({
        from: { coll: 'tables', id: startTableId },
        to: { coll: 'tables', id: endTableId },
        kind: 'relationship',
        viaId: rel.id,
        fieldId: rel.startFieldId as Id | undefined,
        targetFieldId: rel.endFieldId as Id | undefined,
      });
    }
  }

  for (const tbl of doc.tables ?? []) {
    if (Array.isArray(tbl.inherits)) {
      for (const parentName of tbl.inherits) {
        if (typeof parentName === 'string') {
          const parentEnt = tableByName.get(parentName.toLowerCase());
          if (parentEnt) {
            addEdge({
              from: { coll: 'tables', id: tbl.id },
              to: { coll: 'tables', id: parentEnt.id },
              kind: 'inheritance',
            });
          }
        }
      }
    }
    for (const f of (Array.isArray(tbl.fields) ? tbl.fields : []) as Item[]) {
      if (typeof f.type === 'string' && f.type) {
        const lower = f.type.toLowerCase();
        const targetType = customTypeByName.get(lower);
        if (targetType) {
          addEdge({
            from: { coll: 'tables', id: tbl.id },
            to: { coll: 'types', id: targetType.id },
            kind: 'field_type',
            fieldId: f.id,
          });
        }
        const targetEnum = enumByName.get(lower);
        if (targetEnum) {
          addEdge({
            from: { coll: 'tables', id: tbl.id },
            to: { coll: 'enums', id: targetEnum.id },
            kind: 'field_type',
            fieldId: f.id,
          });
        }
      }
    }
  }

  for (const view of doc.views ?? []) {
    const bId = view.baseTableId as Id | null | undefined;
    if (typeof bId === 'string' || typeof bId === 'number') {
      addEdge({ from: { coll: 'views', id: view.id }, to: { coll: 'tables', id: bId }, kind: 'view_base' });
    }
    for (const j of (Array.isArray(view.joins) ? view.joins : []) as Record<string, unknown>[]) {
      const tid = j?.tableId as Id | null | undefined;
      if (typeof tid === 'string' || typeof tid === 'number') {
        addEdge({ from: { coll: 'views', id: view.id }, to: { coll: 'tables', id: tid }, kind: 'view_join', viaId: j.id as Id | undefined });
      }
    }
    for (const c of (Array.isArray(view.columns) ? view.columns : []) as Record<string, unknown>[]) {
      const tid = c?.tableId as Id | null | undefined;
      if (typeof tid === 'string' || typeof tid === 'number') {
        addEdge({ from: { coll: 'views', id: view.id }, to: { coll: 'tables', id: tid }, kind: 'view_column', viaId: c.id as Id | undefined, targetFieldId: c.fieldId as Id | undefined });
      }
    }
    for (const cond of (Array.isArray(view.conditions) ? view.conditions : []) as Record<string, unknown>[]) {
      const tid = cond?.tableId as Id | null | undefined;
      if (typeof tid === 'string' || typeof tid === 'number') {
        addEdge({ from: { coll: 'views', id: view.id }, to: { coll: 'tables', id: tid }, kind: 'view_condition', viaId: cond.id as Id | undefined, targetFieldId: cond.fieldId as Id | undefined });
      }
    }
  }

  return {
    doc,
    version,
    baseHash,
    database,
    entitiesByKey,
    orderedEntities,
    tableByName,
    tableFieldsByKey,
    tableFieldsByName,
    outgoingByKey,
    incomingByKey,
  };
}

export class DocumentIndexCache {
  private readonly byProject = new Map<string, DocumentIndex>();

  constructor(private readonly maxProjects = 16) {}

  getOrCreate(projectId: string, doc: Document, version: number): DocumentIndex {
    const existing = this.byProject.get(projectId);
    if (existing && existing.version === version && existing.doc === doc) {
      return existing;
    }
    const created = indexDocument(doc, version);
    if (this.byProject.size >= this.maxProjects && !this.byProject.has(projectId)) {
      const oldest = this.byProject.keys().next().value;
      if (oldest) this.byProject.delete(oldest);
    }
    this.byProject.set(projectId, created);
    return created;
  }

  evictProject(projectId: string): void {
    this.byProject.delete(projectId);
  }

  clear(): void {
    this.byProject.clear();
  }
}



