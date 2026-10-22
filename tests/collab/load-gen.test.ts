import { describe, expect, it } from 'vitest';
import { applyOps, diffDoc } from '../../src/collab/ops';
import { validateOps } from '../../src/collab/validate';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { generateDiagram, generateNanoid } from '../../scripts/gen-diagram';
import { parseCliArgs, percentile } from '../../scripts/load-test';

describe('gen-diagram and load-test helpers', () => {
  it('generates 21-char URL-safe nanoid strings', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateNanoid();
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });

  it('generates a 200-entity diagram compatible with drawDB JSON import and collab validateOps', () => {
    const diagram = generateDiagram(200);

    expect(diagram.tables).toHaveLength(200);
    expect(diagram.relationships).toHaveLength(250);
    expect(diagram.notes.length).toBeGreaterThanOrEqual(1);
    expect(diagram.areas.length).toBeGreaterThanOrEqual(1);
    expect(diagram.subjectAreas).toEqual(diagram.areas);
    expect(diagram.views.length).toBeGreaterThanOrEqual(1);
    expect(diagram.enums.length).toBeGreaterThanOrEqual(1);
    expect(diagram.types.length).toBeGreaterThanOrEqual(1);

    for (const table of diagram.tables) {
      expect(table.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      expect(table.fields.length).toBeGreaterThanOrEqual(8);
      expect(table.fields.length).toBeLessThanOrEqual(15);
      expect(table.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      for (const field of table.fields) {
        expect(field.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
        expect(typeof field.name).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.check).toBe('string');
        expect(typeof field.primary).toBe('boolean');
        expect(typeof field.unique).toBe('boolean');
        expect(typeof field.increment).toBe('boolean');
        expect(typeof field.comment).toBe('string');
      }
    }

    const tableById = new Map(diagram.tables.map((t) => [t.id, t]));
    for (const rel of diagram.relationships) {
      expect(rel.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      const startTable = tableById.get(String(rel.startTableId));
      const endTable = tableById.get(String(rel.endTableId));
      expect(startTable).toBeDefined();
      expect(endTable).toBeDefined();
      expect(startTable!.fields.some((f) => f.id === rel.startFieldId)).toBe(true);
      expect(endTable!.fields.some((f) => f.id === rel.endFieldId)).toBe(true);
    }

    // Importing the 200-entity diagram in an empty project produces a valid op batch (< 5000 ops)
    const ops = diffDoc(EMPTY_DOC, diagram);
    expect(ops.length).toBeGreaterThan(200);
    expect(ops.length).toBeLessThanOrEqual(5000);

    const validated = validateOps(ops);
    expect(validated).not.toBeNull();

    const applied = applyOps(EMPTY_DOC, validated!);
    expect(applied.ok).toBe(true);
    expect(applied.doc.tables).toHaveLength(200);
    expect(applied.doc.relationships).toHaveLength(250);
  });

  it('parses CLI arguments and computes latency percentiles accurately', () => {
    const parsed = parseCliArgs(['--project', 'proj-123', '--clients', '10', '--seconds', '60']);
    expect(parsed.projectId).toBe('proj-123');
    expect(parsed.clients).toBe(10);
    expect(parsed.seconds).toBe(60);

    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });
});
