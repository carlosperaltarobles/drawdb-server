import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotKind } from '../../src/generated/prisma/client';
import { PRUNE_TX_TIMEOUT_MS } from '../../src/history/constants';
import { pruneSnapshots } from '../../src/history/prune';
import { startHistoryPruning } from '../../src/history/scheduler';
import { EMPTY_DOC } from '../../src/projects/empty-doc';
import { resetDb, testPrisma } from '../helpers/db';

const prisma = testPrisma();
const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createProject(name = 'Proyecto') {
  return prisma.project.create({
    data: { name, diagram: EMPTY_DOC },
  });
}

async function insertSnapshot(
  projectId: string,
  createdAt: Date,
  kind: SnapshotKind = 'auto',
  name: string | null = null,
) {
  return prisma.projectSnapshot.create({
    data: {
      projectId,
      diagram: EMPTY_DOC,
      version: BigInt(1),
      kind,
      name,
      createdAt,
    },
  });
}

describe('pruneSnapshots', () => {
  it('conserva todas las auto de las últimas 48 h', async () => {
    const project = await createProject();
    const s1 = await insertSnapshot(project.id, new Date(NOW.getTime() - 1 * HOUR_MS));
    const s2 = await insertSnapshot(project.id, new Date(NOW.getTime() - 10 * HOUR_MS));
    const s3 = await insertSnapshot(project.id, new Date(NOW.getTime() - 47 * HOUR_MS));

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(0);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(remaining.map((r) => r.id)).toEqual([s1.id, s2.id, s3.id]);
  });

  it('entre 48 h y 30 días conserva la última de cada día', async () => {
    const project = await createProject();
    // 5 días antes de 2026-06-15 es 2026-06-10
    await insertSnapshot(project.id, new Date('2026-06-10T08:00:00.000Z'));
    await insertSnapshot(project.id, new Date('2026-06-10T12:00:00.000Z'));
    const latest = await insertSnapshot(project.id, new Date('2026-06-10T18:00:00.000Z'));

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(2);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(latest.id);
  });

  it('entre 30 días y 6 meses conserva la última de cada semana', async () => {
    const project = await createProject();
    // Semana ISO 2026-W16 (~60 días antes de 2026-06-15): lunes 13, miércoles 15 y viernes 17 de abril de 2026
    await insertSnapshot(project.id, new Date('2026-04-13T10:00:00.000Z'));
    await insertSnapshot(project.id, new Date('2026-04-15T10:00:00.000Z'));
    const latest = await insertSnapshot(project.id, new Date('2026-04-17T10:00:00.000Z'));

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(2);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(latest.id);
  });

  it('borra auto de más de 183 días', async () => {
    const project = await createProject();
    await insertSnapshot(project.id, new Date(NOW.getTime() - 184 * DAY_MS));
    await insertSnapshot(project.id, new Date(NOW.getTime() - 250 * DAY_MS));

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(2);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
    });
    expect(remaining).toHaveLength(0);
  });

  it('nunca borra named', async () => {
    const project = await createProject();
    const named = await insertSnapshot(
      project.id,
      new Date(NOW.getTime() - 400 * DAY_MS),
      'named',
      'Versión inicial',
    );

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(0);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(named.id);
  });

  it('las copias de seguridad se conservan 30 días aunque haya una auto posterior el mismo día', async () => {
    const project = await createProject();
    // Hace 10 días: 2026-06-05
    const safetyRecent = await insertSnapshot(
      project.id,
      new Date('2026-06-05T08:00:00.000Z'),
      'pre_bulk_delete',
    );
    const autoSameDay = await insertSnapshot(
      project.id,
      new Date('2026-06-05T18:00:00.000Z'),
      'auto',
    );
    // Hace 31 días: se debe borrar
    await insertSnapshot(project.id, new Date(NOW.getTime() - 31 * DAY_MS), 'pre_restore');

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(1);

    const remaining = await prisma.projectSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(remaining.map((r) => r.id)).toEqual([safetyRecent.id, autoSameDay.id]);
  });

  it('no mezcla proyectos', async () => {
    const projectA = await createProject('Proyecto A');
    const projectB = await createProject('Proyecto B');
    const snapA = await insertSnapshot(projectA.id, new Date('2026-06-10T10:00:00.000Z'));
    const snapB = await insertSnapshot(projectB.id, new Date('2026-06-10T15:00:00.000Z'));

    const deleted = await pruneSnapshots(prisma, NOW);
    expect(deleted).toBe(0);

    const remaining = await prisma.projectSnapshot.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(remaining.map((r) => r.id)).toEqual([snapA.id, snapB.id]);
  });

  it('startHistoryPruning ejecuta la poda al arrancar con advisory lock y permite detener el temporizador', async () => {
    const project = await createProject('Proyecto Scheduler');
    await insertSnapshot(project.id, new Date(NOW.getTime() - 200 * DAY_MS));
    const kept = await insertSnapshot(project.id, new Date(NOW.getTime() - 2 * HOUR_MS));

    const stop = startHistoryPruning(prisma, {
      intervalMs: 60_000,
      now: () => NOW,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const remaining = await prisma.projectSnapshot.findMany({
        where: { projectId: project.id },
      });
      expect(remaining.map((r) => r.id)).toEqual([kept.id]);
    } finally {
      stop();
    }
  });

  it('las transacciones de poda usan un timeout amplio en lugar de los 5 s por defecto de Prisma', async () => {
    const $transaction = vi.fn().mockResolvedValue(0);
    const fakeDb = { $transaction } as unknown as Parameters<typeof pruneSnapshots>[0];

    await pruneSnapshots(fakeDb, NOW);
    expect($transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: PRUNE_TX_TIMEOUT_MS }),
    );

    const stop = startHistoryPruning(fakeDb as Parameters<typeof startHistoryPruning>[0], {
      intervalMs: 3600_000,
    });
    stop();
    await vi.waitFor(() => expect($transaction).toHaveBeenCalledTimes(2));
    expect($transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: PRUNE_TX_TIMEOUT_MS }),
    );
    expect(PRUNE_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
