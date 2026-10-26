import { randomBytes } from 'node:crypto';
import { applyOp, COLLS, diffDoc, SUBS, type Coll, type Document, type Id, type Item, type Op } from '../collab/ops';
import { validateOps } from '../collab/validate';
import { AppError } from '../http/app-error';
import { summarizeChanges } from './change-summary';
import { entityKey, idKey } from './document-index';
import {
  ALLOWED_CARDINALITIES,
  ALLOWED_CONSTRAINTS,
  ALLOWED_ENTITY_KEYS,
  ALLOWED_SUB_KEYS,
  DATABASE_ENGINES,
  HEX_COLOR_REGEX,
} from './entity-schemas';
import type { ChangeSummary, Scope } from './types';

export type PreparedProposal = {
  after: Document;
  ops: Op[];
  summary: ChangeSummary;
  warnings: string[];
};

const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';

function makeEntityId(size = 16): string {
  const bytes = randomBytes(size);
  let out = 'ai_';
  for (let i = 0; i < size; i++) {
    out += NANOID_ALPHABET[bytes[i] & 63];
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsSqlIdentifier(sql: string, identifier: string): boolean {
  if (!sql || !identifier) return false;
  const re = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegex(identifier)}(?![a-zA-Z0-9_])`, 'i');
  return re.test(sql);
}

function validateAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new AppError('ai_invalid_proposal');
    }
  }
}

function fillDefaultEntityProps(coll: Coll, item: Item, index: number): Item {
  const next: Item = { ...item };
  if (coll === 'tables') {
    if (typeof next.x !== 'number') next.x = (index % 6) * 280;
    if (typeof next.y !== 'number') next.y = Math.floor(index / 6) * 260;
    if (typeof next.comment !== 'string') next.comment = '';
    if (typeof next.color !== 'string') next.color = '#175e7a';
    if (!Array.isArray(next.fields)) next.fields = [];
    if (!Array.isArray(next.indices)) next.indices = [];
    if (!Array.isArray(next.uniqueConstraints)) next.uniqueConstraints = [];
    next.fields = (next.fields as Item[]).map((f) => ({
      default: '',
      check: '',
      primary: false,
      unique: false,
      notNull: false,
      increment: false,
      comment: '',
      ...f,
    }));
    next.indices = (next.indices as Item[]).map((idx, idxPos) => ({
      unique: false,
      fields: [],
      ...idx,
      id: idx.id ?? `idx_${index}_${idxPos}`,
    }));
    next.uniqueConstraints = (next.uniqueConstraints as Item[]).map((uc, ucPos) => ({
      fields: [],
      ...uc,
      id: uc.id ?? `uc_${index}_${ucPos}`,
    }));

  } else if (coll === 'views') {
    if (typeof next.x !== 'number') next.x = (index % 6) * 280;
    if (typeof next.y !== 'number') next.y = Math.floor(index / 6) * 260;
    if (!Array.isArray(next.joins)) next.joins = [];
    if (!Array.isArray(next.columns)) next.columns = [];
    if (!Array.isArray(next.conditions)) next.conditions = [];
    if (typeof next.comment !== 'string') next.comment = '';
    if (typeof next.materialized !== 'boolean') next.materialized = false;
    if (typeof next.color !== 'string') next.color = '#175e7a';
  } else if (coll === 'notes') {
    if (typeof next.x !== 'number') next.x = (index % 6) * 240;
    if (typeof next.y !== 'number') next.y = Math.floor(index / 6) * 200;
    if (typeof next.title !== 'string') next.title = 'Note';
    if (typeof next.content !== 'string') next.content = '';
    if (typeof next.color !== 'string') next.color = '#fcf7ac';
    if (typeof next.height !== 'number') next.height = 120;
  } else if (coll === 'areas') {
    if (typeof next.x !== 'number') next.x = 0;
    if (typeof next.y !== 'number') next.y = 0;
    if (typeof next.width !== 'number') next.width = 400;
    if (typeof next.height !== 'number') next.height = 300;
    if (typeof next.color !== 'string') next.color = '#175e7a';
  } else if (coll === 'types') {
    if (typeof next.comment !== 'string') next.comment = '';
    if (!Array.isArray(next.fields)) next.fields = [];
  } else if (coll === 'enums') {
    if (!Array.isArray(next.values)) next.values = [];
  } else if (coll === 'relationships') {
    if (typeof next.cardinality !== 'string') next.cardinality = 'many_to_one';
    if (typeof next.updateConstraint !== 'string') next.updateConstraint = 'No action';
    if (typeof next.deleteConstraint !== 'string') next.deleteConstraint = 'No action';
  }
  return next;
}

function normalizeAndRemapNewIds(base: Document, rawOps: Op[]): Op[] {
  const existingIds = new Set<string>();
  for (const coll of COLLS) {
    for (const item of base[coll] ?? []) {
      existingIds.add(idKey(item.id));
      if (coll === 'tables') {
        for (const sub of SUBS.tables) {
          for (const sItem of (item[sub] as Item[] | undefined) ?? []) {
            if (sItem?.id !== undefined) existingIds.add(idKey(sItem.id));
          }
        }
      }
    }
  }

  const idMap = new Map<string, Id>();
  const allocId = (proposedId: Id): Id => {
    const key = idKey(proposedId);
    const mapped = idMap.get(key);
    if (mapped !== undefined) return mapped;
    let candidate: Id = proposedId;
    if (
      existingIds.has(key) ||
      (typeof proposedId === 'string' && /^(temp_|new_|tmp_)/i.test(proposedId))
    ) {
      candidate = makeEntityId();
      while (existingIds.has(idKey(candidate))) {
        candidate = makeEntityId();
      }
    }
    existingIds.add(idKey(candidate));
    idMap.set(key, candidate);
    return candidate;
  };

  const resolveId = (id: Id): Id => idMap.get(idKey(id)) ?? id;

  // First pass: register new IDs in `add` and `sadd`
  for (const op of rawOps) {
    if (op.t === 'add') {
      allocId(op.item.id);
      if (op.coll === 'tables') {
        for (const sub of SUBS.tables) {
          for (const s of (op.item[sub] as Item[] | undefined) ?? []) {
            if (s?.id !== undefined) allocId(s.id);
          }
        }
      }
    } else if (op.t === 'sadd') {
      allocId(op.item.id);
    }
  }

  // Second pass: remap references across all ops
  return rawOps.map((op): Op => {
    if (op.t === 'add') {
      const item = fillDefaultEntityProps(op.coll, { ...op.item, id: resolveId(op.item.id) }, op.index);
      if (op.coll === 'tables') {
        for (const sub of SUBS.tables) {
          if (Array.isArray(item[sub])) {
            item[sub] = (item[sub] as Item[]).map((s) => ({
              ...s,
              id: resolveId(s.id),
            }));
          }
        }
      } else if (op.coll === 'relationships') {
        if (item.startTableId !== undefined) item.startTableId = resolveId(item.startTableId as Id);
        if (item.startFieldId !== undefined) item.startFieldId = resolveId(item.startFieldId as Id);
        if (item.endTableId !== undefined) item.endTableId = resolveId(item.endTableId as Id);
        if (item.endFieldId !== undefined) item.endFieldId = resolveId(item.endFieldId as Id);
      } else if (op.coll === 'views') {
        if (item.baseTableId !== null && item.baseTableId !== undefined) {
          item.baseTableId = resolveId(item.baseTableId as Id);
        }
      }
      return { ...op, item };
    }
    if (op.t === 'sadd') {
      const baseItem =
        op.sub === 'fields'
          ? {
              default: '',
              check: '',
              primary: false,
              unique: false,
              notNull: false,
              increment: false,
              comment: '',
              ...op.item,
              id: resolveId(op.item.id),
            }
          : { ...op.item, id: resolveId(op.item.id) };
      return { ...op, id: resolveId(op.id), item: baseItem };
    }
    if (op.t === 'del' || op.t === 'patch') {
      return { ...op, id: resolveId(op.id) };
    }
    if (op.t === 'order') {
      return { ...op, ids: op.ids.map(resolveId) };
    }
    if (op.t === 'sdel' || op.t === 'spatch') {
      return { ...op, id: resolveId(op.id), sid: resolveId(op.sid) };
    }
    if (op.t === 'sorder') {
      return { ...op, id: resolveId(op.id), ids: op.ids.map(resolveId) };
    }
    return op;
  });
}

function validateOpProperties(op: Op): void {
  if (op.t === 'set') throw new AppError('ai_invalid_proposal');
  if (op.t === 'add') {
    validateAllowedKeys(op.item, ALLOWED_ENTITY_KEYS[op.coll]);
    if (op.coll === 'tables') {
      for (const sub of SUBS.tables) {
        for (const sItem of (op.item[sub] as Item[] | undefined) ?? []) {
          if (!isPlainObject(sItem)) throw new AppError('ai_invalid_proposal');
          validateAllowedKeys(sItem, ALLOWED_SUB_KEYS[sub]);
        }
      }
    }
  } else if (op.t === 'patch') {
    validateAllowedKeys(op.patch, ALLOWED_ENTITY_KEYS[op.coll]);
    for (const u of op.unset ?? []) {
      if (!ALLOWED_ENTITY_KEYS[op.coll].has(u)) throw new AppError('ai_invalid_proposal');
    }
  } else if (op.t === 'sadd') {
    validateAllowedKeys(op.item, ALLOWED_SUB_KEYS[op.sub]);
  } else if (op.t === 'spatch') {
    validateAllowedKeys(op.patch, ALLOWED_SUB_KEYS[op.sub]);
    for (const u of op.unset ?? []) {
      if (!ALLOWED_SUB_KEYS[op.sub].has(u)) throw new AppError('ai_invalid_proposal');
    }
  }
}

export function prepareProposal(
  base: Document,
  raw: unknown,
  scope: Scope = { entities: null },
  opts: { maxOps?: number } = {},
): PreparedProposal {
  const maxOps = opts.maxOps ?? 500;

  let rawOpsInput: unknown;
  const warnings: string[] = [];
  if (Array.isArray(raw)) {
    rawOpsInput = raw;
  } else if (isPlainObject(raw) && Array.isArray(raw.ops)) {
    rawOpsInput = raw.ops;
    if (Array.isArray(raw.warnings)) {
      for (const w of raw.warnings) {
        if (typeof w === 'string' && w.trim()) warnings.push(w.trim().slice(0, 500));
      }
    }
  } else {
    throw new AppError('ai_invalid_proposal');
  }

  if (!Array.isArray(rawOpsInput) || rawOpsInput.length === 0 || rawOpsInput.length > maxOps) {
    throw new AppError('ai_invalid_proposal');
  }

  const structurallyValid = validateOps(rawOpsInput);
  if (!structurallyValid || structurallyValid.length === 0 || structurallyValid.length > maxOps) {
    throw new AppError('ai_invalid_proposal');
  }

  for (const op of structurallyValid) {
    validateOpProperties(op);
  }

  const normalizedOps = normalizeAndRemapNewIds(base, structurallyValid);
  const allowedScopeKeys = scope.entities
    ? new Set(scope.entities.map((e) => entityKey(e.coll, e.id)))
    : null;

  const baseTablesByKey = new Map<string, Item>((base.tables ?? []).map((t) => [idKey(t.id), t]));
  const fieldRenames = new Map<string, Map<string, { nextName: string; checkPatched: boolean }>>();
  const touchedEntities = new Set<string>();

  for (const op of normalizedOps) {
    if (op.t === 'set') throw new AppError('ai_invalid_proposal');
    const targetId = op.t === 'add' ? op.item.id : op.t === 'order' ? undefined : op.id;
    if (targetId !== undefined) {
      const eKey = entityKey(op.coll, targetId);
      touchedEntities.add(eKey);
      if (allowedScopeKeys && op.t !== 'add' && !allowedScopeKeys.has(eKey)) {
        throw new AppError('ai_invalid_proposal');
      }
    }
    if (op.t === 'spatch' && op.sub === 'fields' && typeof op.patch.name === 'string') {
      const tbl = baseTablesByKey.get(idKey(op.id));
      const oldField = (tbl?.fields as Item[] | undefined)?.find((f) => idKey(f.id) === idKey(op.sid));
      if (oldField && typeof oldField.name === 'string' && oldField.name !== op.patch.name) {
        let map = fieldRenames.get(idKey(op.id));
        if (!map) {
          map = new Map();
          fieldRenames.set(idKey(op.id), map);
        }
        map.set(oldField.name, {
          nextName: op.patch.name,
          checkPatched: typeof op.patch.check === 'string',
        });
      }
    }
  }

  let nextDoc: Document = { ...base };
  for (const op of normalizedOps) {
    const res = applyOp(nextDoc, op);
    if (!res.ok) throw new AppError('ai_invalid_proposal');
    nextDoc = res.doc;
  }

  if (fieldRenames.size > 0 && Array.isArray(nextDoc.tables)) {
    nextDoc = {
      ...nextDoc,
      tables: nextDoc.tables.map((tbl) => {
        const renames = fieldRenames.get(idKey(tbl.id));
        if (!renames || renames.size === 0) return tbl;
        const fields = Array.isArray(tbl.fields) ? (tbl.fields as Item[]) : [];
        for (const [oldName, info] of renames.entries()) {
          if (typeof nextDoc.sqlHeader === 'string' && containsSqlIdentifier(nextDoc.sqlHeader, oldName)) {
            throw new AppError('ai_invalid_proposal');
          }
          for (const f of fields) {
            if (typeof f.check === 'string' && f.check.trim() && !info.checkPatched) {
              if (containsSqlIdentifier(f.check, oldName)) {
                throw new AppError('ai_invalid_proposal');
              }
            }
          }
        }
        const updateFieldList = (list: Item[] | undefined): Item[] =>
          (list ?? []).map((entry) => {
            if (!Array.isArray(entry.fields)) return entry;
            return {
              ...entry,
              fields: (entry.fields as string[]).map((fName) => renames.get(fName)?.nextName ?? fName),
            };
          });
        return {
          ...tbl,
          indices: updateFieldList(tbl.indices as Item[] | undefined),
          uniqueConstraints: updateFieldList(tbl.uniqueConstraints as Item[] | undefined),
        };
      }),
    };
  }

  validateSemanticDocument(base, nextDoc, touchedEntities);

  const canonicalOps = diffDoc(base, nextDoc);
  if (
    canonicalOps.length === 0 ||
    canonicalOps.length > maxOps ||
    canonicalOps.some((op) => op.t === 'set')
  ) {
    throw new AppError('ai_invalid_proposal');
  }

  const summary = summarizeChanges(base, nextDoc);
  if (summary.items.length === 0) throw new AppError('ai_invalid_proposal');

  return { after: nextDoc, ops: canonicalOps, summary, warnings };
}

function validateSemanticDocument(
  base: Document,
  after: Document,
  touchedEntities: ReadonlySet<string>,
): void {
  const dbName = typeof after.database === 'string' ? after.database.toLowerCase() : 'generic';
  const engine = DATABASE_ENGINES[dbName] ?? DATABASE_ENGINES.generic!;

  const baseTypesCount = (base.types ?? []).length;
  const afterTypes = after.types ?? [];
  if (!engine.hasTypes && afterTypes.length > baseTypesCount) {
    throw new AppError('ai_invalid_proposal');
  }

  const baseEnumsCount = (base.enums ?? []).length;
  const afterEnums = after.enums ?? [];
  if (!engine.hasEnums && afterEnums.length > baseEnumsCount) {
    throw new AppError('ai_invalid_proposal');
  }

  const customTypeNames = new Set<string>();
  for (const t of afterTypes) {
    if (typeof t.name !== 'string' || !t.name.trim()) throw new AppError('ai_invalid_proposal');
    const lower = t.name.trim().toLowerCase();
    if (customTypeNames.has(lower)) throw new AppError('ai_invalid_proposal');
    customTypeNames.add(lower);
  }

  const enumNames = new Set<string>();
  for (const e of afterEnums) {
    if (typeof e.name !== 'string' || !e.name.trim()) throw new AppError('ai_invalid_proposal');
    const lower = e.name.trim().toLowerCase();
    if (enumNames.has(lower)) throw new AppError('ai_invalid_proposal');
    enumNames.add(lower);
  }

  const tablesByKey = new Map<string, Item>();
  const tablesByName = new Map<string, Item>();
  const tableFieldIds = new Map<string, Set<string>>();

  for (const tbl of after.tables ?? []) {
    const tKey = idKey(tbl.id);
    if (tablesByKey.has(tKey)) throw new AppError('ai_invalid_proposal');
    if (typeof tbl.name !== 'string' || !tbl.name.trim()) throw new AppError('ai_invalid_proposal');
    const lowerName = tbl.name.trim().toLowerCase();
    if (tablesByName.has(lowerName)) throw new AppError('ai_invalid_proposal');
    tablesByKey.set(tKey, tbl);
    tablesByName.set(lowerName, tbl);

    const isTouched = touchedEntities.has(entityKey('tables', tbl.id));
    if (isTouched && typeof tbl.color === 'string' && !HEX_COLOR_REGEX.test(tbl.color)) {
      throw new AppError('ai_invalid_proposal');
    }

    const fIds = new Set<string>();
    const fNames = new Set<string>();
    for (const f of (Array.isArray(tbl.fields) ? tbl.fields : []) as Item[]) {
      const fKey = idKey(f.id);
      if (fIds.has(fKey)) throw new AppError('ai_invalid_proposal');
      if (typeof f.name !== 'string' || !f.name.trim()) throw new AppError('ai_invalid_proposal');
      const fLower = f.name.trim().toLowerCase();
      if (fNames.has(fLower)) throw new AppError('ai_invalid_proposal');
      fIds.add(fKey);
      fNames.add(fLower);

      if (isTouched) {
        if (typeof f.type !== 'string' || !f.type.trim()) throw new AppError('ai_invalid_proposal');
        const rawType = f.type.trim();
        const upperType = rawType.toUpperCase().replace(/\(\d+(?:,\s*\d+)?\)$/, '');
        const lowerType = rawType.toLowerCase();
        if (
          !engine.types.has(upperType) &&
          !customTypeNames.has(lowerType) &&
          !enumNames.has(lowerType)
        ) {
          throw new AppError('ai_invalid_proposal');
        }
      }
    }
    tableFieldIds.set(tKey, fIds);

    for (const sub of ['indices', 'uniqueConstraints'] as const) {
      for (const entry of (Array.isArray(tbl[sub]) ? tbl[sub] : []) as Item[]) {
        if (typeof entry.name !== 'string' || !entry.name.trim()) {
          throw new AppError('ai_invalid_proposal');
        }
        if (!Array.isArray(entry.fields)) throw new AppError('ai_invalid_proposal');
        for (const refFieldName of entry.fields) {
          if (typeof refFieldName !== 'string' || !fNames.has(refFieldName.trim().toLowerCase())) {
            throw new AppError('ai_invalid_proposal');
          }
        }
      }
    }
  }

  for (const tbl of after.tables ?? []) {
    if (!Array.isArray(tbl.inherits)) continue;
    const visited = new Set<string>([tbl.name ? String(tbl.name).toLowerCase() : '']);
    const queue = [...(tbl.inherits as string[])];
    while (queue.length > 0) {
      const parentName = queue.shift()!;
      if (typeof parentName !== 'string') throw new AppError('ai_invalid_proposal');
      const lowerParent = parentName.toLowerCase();
      if (visited.has(lowerParent)) throw new AppError('ai_invalid_proposal');
      const parentTbl = tablesByName.get(lowerParent);
      if (!parentTbl) throw new AppError('ai_invalid_proposal');
      visited.add(lowerParent);
      if (Array.isArray(parentTbl.inherits)) {
        queue.push(...(parentTbl.inherits as string[]));
      }
    }
  }

  const relIds = new Set<string>();
  for (const rel of after.relationships ?? []) {
    const rKey = idKey(rel.id);
    if (relIds.has(rKey)) throw new AppError('ai_invalid_proposal');
    relIds.add(rKey);
    const startFields = tableFieldIds.get(idKey(rel.startTableId as Id));
    const endFields = tableFieldIds.get(idKey(rel.endTableId as Id));
    if (
      !startFields ||
      !endFields ||
      !startFields.has(idKey(rel.startFieldId as Id)) ||
      !endFields.has(idKey(rel.endFieldId as Id))
    ) {
      throw new AppError('ai_invalid_proposal');
    }
    if (typeof rel.cardinality === 'string' && !ALLOWED_CARDINALITIES.has(rel.cardinality)) {
      throw new AppError('ai_invalid_proposal');
    }
    if (
      (typeof rel.updateConstraint === 'string' && !ALLOWED_CONSTRAINTS.has(rel.updateConstraint)) ||
      (typeof rel.deleteConstraint === 'string' && !ALLOWED_CONSTRAINTS.has(rel.deleteConstraint))
    ) {
      throw new AppError('ai_invalid_proposal');
    }
  }

  const viewNames = new Set<string>();
  for (const view of after.views ?? []) {
    if (typeof view.name !== 'string' || !view.name.trim()) throw new AppError('ai_invalid_proposal');
    const lowerVName = view.name.trim().toLowerCase();
    if (viewNames.has(lowerVName) || tablesByName.has(lowerVName)) {
      throw new AppError('ai_invalid_proposal');
    }
    viewNames.add(lowerVName);
    if (view.materialized === true && !engine.hasMaterializedViews) {
      throw new AppError('ai_invalid_proposal');
    }
    if (view.baseTableId !== null && view.baseTableId !== undefined) {
      if (!tablesByKey.has(idKey(view.baseTableId as Id))) throw new AppError('ai_invalid_proposal');
    }
    for (const col of (Array.isArray(view.columns) ? view.columns : []) as Record<string, unknown>[]) {
      if (col.tableId !== null && col.tableId !== undefined) {
        const tFields = tableFieldIds.get(idKey(col.tableId as Id));
        if (!tFields) throw new AppError('ai_invalid_proposal');
        if (col.fieldId !== null && col.fieldId !== undefined && !tFields.has(idKey(col.fieldId as Id))) {
          throw new AppError('ai_invalid_proposal');
        }
      }
    }
    for (const j of (Array.isArray(view.joins) ? view.joins : []) as Record<string, unknown>[]) {
      if (j.tableId !== null && j.tableId !== undefined) {
        const rightFields = tableFieldIds.get(idKey(j.tableId as Id));
        if (!rightFields) throw new AppError('ai_invalid_proposal');
        if (isPlainObject(j.on)) {
          const leftFields = tableFieldIds.get(idKey(j.on.leftTableId as Id));
          if (
            !leftFields ||
            !leftFields.has(idKey(j.on.leftFieldId as Id)) ||
            !rightFields.has(idKey(j.on.rightFieldId as Id))
          ) {
            throw new AppError('ai_invalid_proposal');
          }
        }
      }
    }
    for (const cond of (Array.isArray(view.conditions) ? view.conditions : []) as Record<string, unknown>[]) {
      if (cond.tableId !== null && cond.tableId !== undefined) {
        const tFields = tableFieldIds.get(idKey(cond.tableId as Id));
        if (!tFields) throw new AppError('ai_invalid_proposal');
        if (cond.fieldId !== null && cond.fieldId !== undefined && !tFields.has(idKey(cond.fieldId as Id))) {
          throw new AppError('ai_invalid_proposal');
        }
      }
    }
  }
}




