import { randomBytes } from 'node:crypto';
import type { Document, Id, Item } from '../src/collab/ops';

const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';

export function generateNanoid(size = 21): string {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
}

export interface GeneratedField extends Item {
  id: string;
  name: string;
  type: string;
  default: string | number | boolean;
  check: string;
  primary: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  comment: string;
  size?: string | number;
  values?: string[];
}

export interface GeneratedIndex extends Item {
  id: string;
  name: string;
  unique: boolean;
  fields: string[];
}

export interface GeneratedUniqueConstraint extends Item {
  id: string;
  name: string;
  fields: string[];
}

export interface GeneratedTable extends Item {
  id: string;
  name: string;
  x: number;
  y: number;
  fields: GeneratedField[];
  comment: string;
  locked: boolean;
  hidden: boolean;
  collapsed: boolean;
  indices: GeneratedIndex[];
  uniqueConstraints: GeneratedUniqueConstraint[];
  color: string;
}

export interface GeneratedRelationship extends Item {
  id: string;
  name: string;
  startTableId: Id;
  startFieldId: Id;
  endTableId: Id;
  endFieldId: Id;
  cardinality: string;
  updateConstraint: string;
  deleteConstraint: string;
}

export interface GeneratedArea extends Item {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked: boolean;
  color: string;
}

export interface GeneratedNote extends Item {
  id: string;
  x: number;
  y: number;
  title: string;
  content: string;
  color: string;
  height: number;
  width: number;
  locked: boolean;
}

export interface GeneratedDiagram extends Document {
  title: string;
  database: string;
  sqlHeader: string;
  tables: GeneratedTable[];
  relationships: GeneratedRelationship[];
  notes: GeneratedNote[];
  areas: GeneratedArea[];
  subjectAreas: GeneratedArea[];
  views: Item[];
  enums: Item[];
  types: Item[];
}

const TABLE_COLORS = [
  '#175e7a',
  '#2563eb',
  '#4f46e5',
  '#0891b2',
  '#059669',
  '#d97706',
  '#dc2626',
  '#7c3aed',
];

const FIELD_SPECS: Array<{
  name: string;
  type: string;
  default: string | number | boolean;
  notNull: boolean;
  unique: boolean;
  size?: number;
}> = [
  { name: 'code', type: 'VARCHAR', default: '', notNull: true, unique: true, size: 64 },
  { name: 'title', type: 'VARCHAR', default: '', notNull: true, unique: false, size: 255 },
  { name: 'description', type: 'TEXT', default: '', notNull: false, unique: false },
  { name: 'status', type: 'VARCHAR', default: "'active'", notNull: true, unique: false, size: 32 },
  { name: 'amount', type: 'NUMERIC', default: 0, notNull: true, unique: false },
  { name: 'is_active', type: 'BOOLEAN', default: true, notNull: true, unique: false },
  { name: 'priority', type: 'INTEGER', default: 0, notNull: true, unique: false },
  { name: 'metadata', type: 'JSONB', default: "'{}'", notNull: false, unique: false },
  { name: 'external_ref', type: 'UUID', default: '', notNull: false, unique: false },
  { name: 'published_at', type: 'TIMESTAMPTZ', default: '', notNull: false, unique: false },
  { name: 'created_at', type: 'TIMESTAMPTZ', default: 'NOW()', notNull: true, unique: false },
  { name: 'updated_at', type: 'TIMESTAMPTZ', default: 'NOW()', notNull: true, unique: false },
];

const CARDINALITIES = ['many_to_one', 'one_to_many', 'one_to_one'] as const;
const CONSTRAINTS = ['No action', 'Restrict', 'Cascade', 'Set null'] as const;

export function generateDiagram(tableCount = 200): GeneratedDiagram {
  const count = Math.max(1, Math.floor(tableCount));
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const tables: GeneratedTable[] = [];

  for (let i = 0; i < count; i++) {
    const tableId = generateNanoid();
    const fieldCount = 8 + (i % 8); // 8..15 fields inclusive
    const fields: GeneratedField[] = [];

    fields.push({
      id: generateNanoid(),
      name: 'id',
      type: 'BIGINT',
      default: '',
      check: '',
      primary: true,
      unique: true,
      notNull: true,
      increment: true,
      comment: `Primary key for entity_${i + 1}`,
    });

    const fkSlots = count > 1 ? 2 : 0;
    for (let f = 0; f < fkSlots; f++) {
      fields.push({
        id: generateNanoid(),
        name: f === 0 ? 'parent_ref_id' : 'related_ref_id',
        type: 'BIGINT',
        default: '',
        check: '',
        primary: false,
        unique: false,
        notNull: f === 0,
        increment: false,
        comment: `Foreign key slot ${f + 1}`,
      });
    }

    const remaining = fieldCount - fields.length;
    for (let k = 0; k < remaining; k++) {
      const spec = FIELD_SPECS[k % FIELD_SPECS.length];
      const suffix = k >= FIELD_SPECS.length ? `_${k}` : '';
      const fieldName = `${spec.name}${suffix}`;
      const field: GeneratedField = {
        id: generateNanoid(),
        name: fieldName,
        type: spec.type,
        default: spec.default,
        check: '',
        primary: false,
        unique: spec.unique && k === 0,
        notNull: spec.notNull,
        increment: false,
        comment: `${fieldName} column of entity_${i + 1}`,
      };
      if (spec.size !== undefined) {
        field.size = spec.size;
      }
      fields.push(field);
    }

    const col = i % cols;
    const row = Math.floor(i / cols);

    const indices: GeneratedIndex[] = [
      {
        id: generateNanoid(),
        name: `idx_entity_${i + 1}_${fields[1]?.name ?? 'id'}`,
        unique: false,
        fields: [fields[1]?.name ?? 'id'],
      },
    ];

    const uniqueConstraints: GeneratedUniqueConstraint[] = [
      {
        id: generateNanoid(),
        name: `uq_entity_${i + 1}_${fields[fields.length - 1].name}`,
        fields: [fields[fields.length - 1].name],
      },
    ];

    tables.push({
      id: tableId,
      name: `entity_${i + 1}`,
      x: col * 320,
      y: row * 460,
      fields,
      comment: `Generated table #${i + 1} for load testing`,
      locked: false,
      hidden: false,
      collapsed: false,
      indices,
      uniqueConstraints,
      color: TABLE_COLORS[i % TABLE_COLORS.length],
    });
  }

  const relationships: GeneratedRelationship[] = [];
  if (count > 1) {
    const targetRelCount = Math.round(count * 1.25); // 250 for n=200
    for (let r = 0; r < targetRelCount; r++) {
      const startIdx = r % count;
      const offset = 1 + ((Math.floor(r / count) + (r % (count - 1))) % (count - 1));
      const endIdx = (startIdx + offset) % count;
      const startTable = tables[startIdx];
      const endTable = tables[endIdx];
      const fkFieldIndex = r < count ? 1 : Math.min(2, startTable.fields.length - 1);
      const startField = startTable.fields[fkFieldIndex];
      const endField = endTable.fields[0];

      relationships.push({
        id: generateNanoid(),
        name: `fk_${startTable.name}_${endTable.name}_${r + 1}`,
        startTableId: startTable.id,
        startFieldId: startField.id,
        endTableId: endTable.id,
        endFieldId: endField.id,
        cardinality: CARDINALITIES[r % CARDINALITIES.length],
        updateConstraint: CONSTRAINTS[r % CONSTRAINTS.length],
        deleteConstraint: CONSTRAINTS[(r + 1) % CONSTRAINTS.length],
      });
    }
  }

  const areas: GeneratedArea[] = [
    {
      id: generateNanoid(),
      name: 'Core Domain',
      x: -80,
      y: -80,
      width: Math.min(cols, 5) * 320,
      height: 960,
      locked: false,
      color: '#175e7a',
    },
    {
      id: generateNanoid(),
      name: 'Analytics & Billing',
      x: Math.min(cols, 5) * 320,
      y: -80,
      width: Math.max(1, cols - 5) * 320,
      height: 960,
      locked: false,
      color: '#059669',
    },
  ];

  const notes: GeneratedNote[] = [
    {
      id: generateNanoid(),
      x: -320,
      y: 0,
      title: 'Load Test Diagram',
      content: `Generated diagram with ${count} tables and ${relationships.length} relationships.`,
      color: '#fcf7ac',
      height: 120,
      width: 220,
      locked: false,
    },
  ];

  const enums: Item[] = [
    {
      id: generateNanoid(),
      name: 'entity_status',
      values: ['draft', 'active', 'archived'],
    },
  ];

  const types: Item[] = [
    {
      id: generateNanoid(),
      name: 'audit_metadata',
      comment: 'Audit trail composite type',
      fields: [
        {
          id: generateNanoid(),
          name: 'actor_id',
          type: 'UUID',
        },
        {
          id: generateNanoid(),
          name: 'source_ip',
          type: 'VARCHAR',
        },
      ],
    },
  ];

  const views: Item[] = [
    {
      id: generateNanoid(),
      name: 'v_active_entities',
      x: -320,
      y: 200,
      width: 220,
      baseTableId: tables[0].id,
      joins: [],
      columns: [
        {
          id: generateNanoid(),
          tableId: tables[0].id,
          fieldId: tables[0].fields[0].id,
          alias: 'entity_id',
        },
      ],
      conditions: [],
      comment: 'Active entities overview',
      materialized: false,
      locked: false,
      hidden: false,
      color: '#175e7a',
    },
  ];

  return {
    title: `Load Test (${count} entities)`,
    database: 'postgresql',
    sqlHeader: '',
    tables,
    relationships,
    notes,
    areas,
    subjectAreas: areas,
    views,
    enums,
    types,
  };
}

if (require.main === module) {
  const rawArg = process.argv[2];
  const parsed = rawArg !== undefined ? Number.parseInt(rawArg, 10) : 200;
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
  const diagram = generateDiagram(n);
  process.stdout.write(`${JSON.stringify(diagram, null, 2)}\n`);
}
