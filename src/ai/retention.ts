import type { PrismaClient } from '../db/prisma';
import type { Prisma } from '../generated/prisma/client';
import { PRUNE_INTERVAL_MS, PRUNE_TX_TIMEOUT_MS } from '../history/constants';

const AI_RETENTION_LOCK_ID = BigInt(8_492_816_305_221);
const DAY_MS = 24 * 3600_000;
export const AI_INACTIVE_CONVERSATION_DAYS = 30;

export type AiPruneResult = {
  expiredProposals: number;
  deletedProposals: number;
  deletedConversations: number;
};

async function runAiPruneQueries(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<AiPruneResult> {
  const inactiveCutoff = new Date(now.getTime() - AI_INACTIVE_CONVERSATION_DAYS * DAY_MS);

  const expiredRes = await tx.aiProposal.updateMany({
    where: {
      status: 'pending',
      expiresAt: { lte: now },
    },
    data: {
      status: 'expired',
    },
  });

  // Delete non-applied proposals older than 30 days
  const deletedProposalsRes = await tx.aiProposal.deleteMany({
    where: {
      status: { in: ['superseded', 'discarded', 'expired'] },
      updatedAt: { lt: inactiveCutoff },
    },
  });

  // Delete conversations inactive for >30 days that do NOT have active generations
  const deletedConversationsRes = await tx.aiConversation.deleteMany({
    where: {
      updatedAt: { lt: inactiveCutoff },
      generations: {
        none: {
          status: { in: ['pending', 'running'] },
        },
      },
    },
  });

  return {
    expiredProposals: expiredRes.count,
    deletedProposals: deletedProposalsRes.count,
    deletedConversations: deletedConversationsRes.count,
  };
}

export async function pruneAiData(
  db: PrismaClient | Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<AiPruneResult> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return db.$transaction((tx) => runAiPruneQueries(tx, now), {
      timeout: PRUNE_TX_TIMEOUT_MS,
    });
  }
  return runAiPruneQueries(db, now);
}

export async function recoverOrphanedGenerations(db: PrismaClient): Promise<number> {
  return db.$transaction(async (tx) => {
    const orphans = await tx.aiGeneration.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true, assistantMessageId: true },
    });
    if (orphans.length === 0) return 0;

    const genIds = orphans.map((o) => o.id);
    const msgIds = orphans.map((o) => o.assistantMessageId);

    await tx.aiMessage.updateMany({
      where: { id: { in: msgIds }, status: 'pending' },
      data: { status: 'failed' },
    });

    const updated = await tx.aiGeneration.updateMany({
      where: { id: { in: genIds } },
      data: { status: 'failed', errorCode: 'ai_unavailable' },
    });

    return updated.count;
  });
}

export function startAiRetention(
  db: PrismaClient,
  opts?: { intervalMs?: number; now?: () => Date },
): () => void {
  const intervalMs = opts?.intervalMs ?? PRUNE_INTERVAL_MS;
  const now = opts?.now ?? (() => new Date());

  const runPass = async () => {
    try {
      await db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${AI_RETENTION_LOCK_ID}::bigint) AS locked
          `;
          if (!rows[0]?.locked) return;
          await runAiPruneQueries(tx, now());
        },
        { timeout: PRUNE_TX_TIMEOUT_MS },
      );
    } catch (err) {
      console.error('AI retention pass failed:', err);
    }
  };

  void recoverOrphanedGenerations(db)
    .catch((err) => console.error('Failed to recover orphaned AI generations:', err))
    .finally(() => {
      void runPass();
    });

  const timer = setInterval(() => {
    void runPass();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
