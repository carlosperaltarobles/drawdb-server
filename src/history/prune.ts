import type { Prisma } from '../generated/prisma/client';
import type { PrismaClient } from '../db/prisma';
import {
  DAILY_UNTIL_DAYS,
  KEEP_ALL_MS,
  PRUNE_TX_TIMEOUT_MS,
  SAFETY_KEEP_DAYS,
  WEEKLY_UNTIL_DAYS,
} from './constants';

const DAY_MS = 24 * 3600_000;

async function runPruneQueries(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const keepAllCutoff = new Date(now.getTime() - KEEP_ALL_MS);
  const dailyCutoff = new Date(now.getTime() - DAILY_UNTIL_DAYS * DAY_MS);
  const weeklyCutoff = new Date(now.getTime() - WEEKLY_UNTIL_DAYS * DAY_MS);
  const safetyCutoff = new Date(now.getTime() - SAFETY_KEEP_DAYS * DAY_MS);

  const deletedDaily = await tx.$executeRaw`
    DELETE FROM project_snapshots
    WHERE id IN (
      SELECT id
      FROM (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY project_id, date_trunc('day', created_at)
            ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM project_snapshots
        WHERE kind = 'auto'::"SnapshotKind"
          AND created_at >= ${dailyCutoff}
          AND created_at < ${keepAllCutoff}
      ) ranked
      WHERE ranked.rn > 1
    )
  `;

  const deletedWeekly = await tx.$executeRaw`
    DELETE FROM project_snapshots
    WHERE id IN (
      SELECT id
      FROM (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY project_id, date_trunc('week', created_at)
            ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM project_snapshots
        WHERE kind = 'auto'::"SnapshotKind"
          AND created_at >= ${weeklyCutoff}
          AND created_at < ${dailyCutoff}
      ) ranked
      WHERE ranked.rn > 1
    )
  `;

  const deletedOldAuto = await tx.$executeRaw`
    DELETE FROM project_snapshots
    WHERE kind = 'auto'::"SnapshotKind"
      AND created_at < ${weeklyCutoff}
  `;

  const deletedOldSafety = await tx.$executeRaw`
    DELETE FROM project_snapshots
    WHERE kind IN ('pre_restore'::"SnapshotKind", 'pre_bulk_delete'::"SnapshotKind")
      AND created_at < ${safetyCutoff}
  `;

  return (
    Number(deletedDaily) + Number(deletedWeekly) + Number(deletedOldAuto) + Number(deletedOldSafety)
  );
}

export async function pruneSnapshots(
  db: PrismaClient | Prisma.TransactionClient,
  now: Date,
): Promise<number> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return db.$transaction((tx) => runPruneQueries(tx, now), {
      timeout: PRUNE_TX_TIMEOUT_MS,
    });
  }
  return runPruneQueries(db, now);
}
