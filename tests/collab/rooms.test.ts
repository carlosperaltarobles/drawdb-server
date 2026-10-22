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
    expect(first).toEqual({ doc: EMPTY_DOC, version: 0 });
    expect(second).toEqual({ doc: EMPTY_DOC, version: 0 });

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

  it('con snapshotIntervalMs=0 y snapshotKeep=3, tras 5 guardados quedan 3 snapshots', async () => {
    const project = await prisma.project.create({
      data: { name: 'Snapshots', diagram: EMPTY_DOC },
    });
    const rooms = new RoomManager(prisma, {
      saveDebounceMs: 60_000,
      snapshotIntervalMs: 0,
      snapshotKeep: 3,
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
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((s) => Number(s.version))).toEqual([3, 4, 5]);
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
});
