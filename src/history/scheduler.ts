import type { PrismaClient } from '../db/prisma';
import { PRUNE_INTERVAL_MS, PRUNE_TX_TIMEOUT_MS } from './constants';
import { pruneSnapshots } from './prune';

const HISTORY_PRUNE_LOCK_ID = BigInt(7_492_816_305_119);

export type HistoryPruningOptions = {
  intervalMs?: number;
  now?: () => Date;
};

export function startHistoryPruning(db: PrismaClient, opts?: HistoryPruningOptions): () => void {
  const intervalMs = opts?.intervalMs ?? PRUNE_INTERVAL_MS;
  const now = opts?.now ?? (() => new Date());

  const runPass = async () => {
    try {
      await db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${HISTORY_PRUNE_LOCK_ID}::bigint) AS locked
        `;
          if (!rows[0]?.locked) {
            return;
          }
          await pruneSnapshots(tx, now());
        },
        { timeout: PRUNE_TX_TIMEOUT_MS },
      );
    } catch (err) {
      console.error(err);
    }
  };

  void runPass();

  const timer = setInterval(() => {
    void runPass();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
