import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../../src/collab/rooms';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { resetDb, testPrisma } from '../helpers/db';

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RoomManager', () => {
  it('loads project once (singleflight), applies ops, and flushes to DB', async () => {
    const project = await prisma.project.create({
      data: { name: 'Singleflight', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });

    const [first, second] = await Promise.all([rooms.join(project.id), rooms.join(project.id)]);
    expect(first).toEqual({ doc: EMPTY_DOC, version: 0, epoch: 0 });
    expect(second).toEqual({ doc: EMPTY_DOC, version: 0, epoch: 0 });

    const res1 = rooms.apply(project.id, [
      { t: 'add', coll: 'tables', item: { id: 't1', name: 'users', fields: [] }, index: 0 },
    ]);
    expect(res1.ok).toBe(true);
    expect(res1.version).toBe(1);
    expect(res1.applied).toHaveLength(1);

    // Concurrent join after in-memory apply must see version 1, not stale DB version 0
    const third = await rooms.join(project.id);
    expect(third.version).toBe(1);
    expect(third.doc.tables).toEqual([{ id: 't1', name: 'users', fields: [] }]);

    // Rejected op alone does not increment version
    const rejected = rooms.apply(project.id, [
      { t: 'patch', coll: 'tables', id: 'missing', patch: { name: 'nope' } },
    ]);
    expect(rejected).toEqual({ applied: [], version: 1, ok: false });

    await rooms.flush(project.id);
    const saved = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(saved.version)).toBe(1);
    expect(saved.diagram).toMatchObject({
      tables: [{ id: 't1', name: 'users', fields: [] }],
    });
  });

  it('con saveDebounceMs=50, la base de datos refleja los cambios sin necesidad de flush explícito', async () => {
    const project = await prisma.project.create({
      data: { name: 'Debounce', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 50 });

    await rooms.join(project.id);
    rooms.apply(project.id, [
      { t: 'add', coll: 'notes', item: { id: 'n1', content: 'auto' }, index: 0 },
    ]);

    await sleep(150);

    const saved = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(saved.version)).toBe(1);
    expect(saved.diagram).toMatchObject({
      notes: [{ id: 'n1', content: 'auto' }],
    });
    await rooms.flushAll();
  });

  it('ya no poda copias al guardar', async () => {
    const project = await prisma.project.create({
      data: { name: 'Snapshots', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, {
      saveDebounceMs: 60_000,
      snapshotIntervalMs: 0,
    });

    await rooms.join(project.id);
    for (let i = 1; i <= 5; i++) {
      rooms.apply(project.id, [
        { t: 'add', coll: 'notes', item: { id: `n${i}`, title: `Note ${i}` }, index: i - 1 },
      ]);
      await rooms.flush(project.id);
    }

    const snapshots = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'asc' },
    });
    expect(snapshots).toHaveLength(5);
    expect(snapshots.map((s) => Number(s.version))).toEqual([1, 2, 3, 4, 5]);
  });

  it('la copia automática registra los autores desde la copia anterior', async () => {
    const project = await prisma.project.create({
      data: { name: 'Authors', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, {
      saveDebounceMs: 60_000,
      snapshotIntervalMs: 0,
    });

    await rooms.join(project.id);
    rooms.apply(
      project.id,
      [{ t: 'add', coll: 'notes', item: { id: 'n1', title: 'Note 1' }, index: 0 }],
      { author: { id: 'u1', name: 'Ana' } },
    );
    rooms.apply(
      project.id,
      [{ t: 'add', coll: 'notes', item: { id: 'n2', title: 'Note 2' }, index: 1 }],
      { author: { id: 'u2', name: 'Luis' } },
    );
    await rooms.flush(project.id);

    const firstSnapshots = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
    });
    expect(firstSnapshots).toHaveLength(1);
    expect(firstSnapshots[0].kind).toBe('auto');
    expect(firstSnapshots[0].authors).toEqual(
      expect.arrayContaining([
        { id: 'u1', name: 'Ana' },
        { id: 'u2', name: 'Luis' },
      ]),
    );
    expect(firstSnapshots[0].authors).toHaveLength(2);
    expect(firstSnapshots[0].sizeBytes).toBeGreaterThan(0);

    rooms.apply(
      project.id,
      [{ t: 'add', coll: 'notes', item: { id: 'n3', title: 'Note 3' }, index: 2 }],
      { author: { id: 'u2', name: 'Luis' } },
    );
    await rooms.flush(project.id);

    const secondSnapshots = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
    });
    expect(secondSnapshots).toHaveLength(2);
    expect(secondSnapshots[0].kind).toBe('auto');
    expect(secondSnapshots[0].authors).toEqual([{ id: 'u2', name: 'Luis' }]);
    expect(secondSnapshots[0].sizeBytes).toBeGreaterThan(0);
  });

  it('rechaza un lote con epoch distinto sin aplicarlo', async () => {
    const project = await prisma.project.create({
      data: { name: 'EpochCheck', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });

    const joined = await rooms.join(project.id);
    expect(joined.epoch).toBe(0);

    const stale = rooms.apply(project.id, [{ t: 'set', key: 'database', value: 'postgresql' }], {
      epoch: 1,
    });
    expect(stale).toEqual({
      applied: [],
      ok: false,
      staleEpoch: true,
      version: 0,
    });

    const validWithEpoch = rooms.apply(
      project.id,
      [{ t: 'set', key: 'database', value: 'postgresql' }],
      { epoch: 0 },
    );
    expect(validWithEpoch.ok).toBe(true);
    expect(validWithEpoch.version).toBe(1);
    expect(validWithEpoch.applied).toHaveLength(1);

    const validWithoutCtx = rooms.apply(project.id, [
      { t: 'set', key: 'sqlHeader', value: '-- header' },
    ]);
    expect(validWithoutCtx.ok).toBe(true);
    expect(validWithoutCtx.version).toBe(2);
    expect(validWithoutCtx.applied).toHaveLength(1);
  });

  it('release guarda y descarga la sala cuando queda vacía, y recarga desde DB al volver a entrar', async () => {
    const project = await prisma.project.create({
      data: { name: 'Release', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });

    await rooms.join(project.id);
    rooms.apply(project.id, [{ t: 'set', key: 'database', value: 'postgresql' }]);

    await rooms.release(project.id);

    const inDb = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(Number(inDb.version)).toBe(1);
    expect(inDb.diagram).toMatchObject({ database: 'postgresql' });

    const rejoined = await rooms.join(project.id);
    expect(rejoined.version).toBe(1);
    expect(rejoined.doc.database).toBe('postgresql');
  });

  it('cancela el guardado pendiente si el proyecto se elimina antes del flush', async () => {
    const project = await prisma.project.create({
      data: { name: 'DeleteRace', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 40, snapshotIntervalMs: 0 });

    await rooms.join(project.id);
    rooms.apply(project.id, [{ t: 'set', key: 'sqlHeader', value: '-- comment' }]);

    await prisma.project.delete({ where: { id: project.id } });
    rooms.onProjectDeleted(project.id);

    await sleep(100);
    await rooms.flushAll();

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectSnapshot.count()).toBe(0);
  });

  it('guarda una copia pre_bulk_delete con el documento anterior al borrado', async () => {
    const initialTables = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i + 1}`,
      name: `table_${i + 1}`,
      fields: [],
    }));
    const project = await prisma.project.create({
      data: {
        name: 'BulkDelete',
        diagram: { ...EMPTY_DOC, tables: initialTables },
      },
    });
    const rooms = new RoomManager(prisma, { saveDebounceMs: 60_000 });

    await rooms.join(project.id);

    const deleteAllTables = initialTables.map((t) => ({
      t: 'del' as const,
      coll: 'tables' as const,
      id: t.id,
    }));
    const res = rooms.apply(project.id, deleteAllTables, {
      author: { id: 'u1', name: 'Ana' },
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toHaveLength(6);

    await rooms.idle();

    const snapshotsAfterFirst = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id, kind: 'pre_bulk_delete' },
    });
    expect(snapshotsAfterFirst).toHaveLength(1);
    expect(snapshotsAfterFirst[0].authors).toEqual([{ id: 'u1', name: 'Ana' }]);
    expect(snapshotsAfterFirst[0].sizeBytes).toBeGreaterThan(0);
    const savedDiagram = snapshotsAfterFirst[0].diagram as { tables: unknown[] };
    expect(savedDiagram.tables).toHaveLength(6);

    // Un segundo lote masivo inmediato no crea otra copia por el cooldown
    rooms.apply(
      project.id,
      Array.from({ length: 5 }, (_, i) => ({
        t: 'add' as const,
        coll: 'notes' as const,
        item: { id: `n${i + 1}`, content: `Note ${i + 1}` },
        index: i,
      })),
    );
    rooms.apply(
      project.id,
      Array.from({ length: 5 }, (_, i) => ({
        t: 'del' as const,
        coll: 'notes' as const,
        id: `n${i + 1}`,
      })),
      { author: { id: 'u1', name: 'Ana' } },
    );

    await rooms.idle();

    const snapshotsAfterSecond = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id, kind: 'pre_bulk_delete' },
    });
    expect(snapshotsAfterSecond).toHaveLength(1);
  });
});
