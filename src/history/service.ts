import type { PublicUser } from '../auth/public-user';
import type { PrismaClient } from '../db/prisma';
import type { Prisma, SnapshotKind } from '../generated/prisma/client';
import { AppError } from '../http/app-error';
import { getRole } from '../projects/repo';
import { HISTORY_PAGE, NAMED_LIMIT } from './constants';
import type { Author, HistoryRooms, SnapshotMeta } from './types';

export type HistoryServiceDeps = {
  prisma: PrismaClient;
  history: HistoryRooms;
};

export type SnapshotDetail = SnapshotMeta & {
  diagram: unknown;
};

const metaSelect = {
  id: true,
  kind: true,
  name: true,
  createdAt: true,
  sizeBytes: true,
  authors: true,
  creator: { select: { id: true, name: true } },
} as const;

type MetaRow = {
  id: string;
  kind: SnapshotKind;
  name: string | null;
  createdAt: Date;
  sizeBytes: number | null;
  authors: unknown;
  creator: Author | null;
};

function parseAuthors(raw: unknown): Author[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const result: Author[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const { id, name } = item as Author;
      result.push({ id, name });
    }
  }
  return result;
}

function toSnapshotMeta(row: MetaRow): SnapshotMeta {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt,
    createdBy: row.creator,
    authors: parseAuthors(row.authors),
    sizeBytes: row.sizeBytes,
  };
}

export class HistoryService {
  constructor(private readonly deps: HistoryServiceDeps) {}

  private async requireRead(projectId: string, user: PublicUser): Promise<void> {
    const role = await getRole(this.deps.prisma, projectId, user);
    if (!role) throw new AppError('not_found');
  }

  private async requireWrite(projectId: string, user: PublicUser): Promise<void> {
    const role = await getRole(this.deps.prisma, projectId, user);
    if (!role) throw new AppError('not_found');
    if (role === 'viewer') throw new AppError('forbidden');
  }

  async list(
    projectId: string,
    user: PublicUser,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: SnapshotMeta[]; nextCursor: string | null }> {
    await this.requireRead(projectId, user);
    const limit = opts.limit ?? HISTORY_PAGE;
    const rows = await this.deps.prisma.projectSnapshot.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: metaSelect,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toSnapshotMeta);
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  async get(projectId: string, snapshotId: string, user: PublicUser): Promise<SnapshotDetail> {
    await this.requireRead(projectId, user);
    const row = await this.deps.prisma.projectSnapshot.findFirst({
      where: { id: snapshotId, projectId },
      select: { ...metaSelect, diagram: true },
    });
    if (!row) throw new AppError('not_found');
    return {
      ...toSnapshotMeta(row),
      diagram: row.diagram,
    };
  }

  async create(projectId: string, name: string, user: PublicUser): Promise<SnapshotMeta> {
    await this.requireWrite(projectId, user);
    const { doc, version } = await this.deps.history.peekDoc(projectId);
    const diagram = doc as Prisma.InputJsonValue;
    const sizeBytes = Buffer.byteLength(JSON.stringify(diagram));

    const row = await this.deps.prisma.$transaction(async (tx) => {
      const count = await tx.projectSnapshot.count({
        where: { projectId, kind: 'named' },
      });
      if (count >= NAMED_LIMIT) {
        throw new AppError('snapshot_limit');
      }
      return tx.projectSnapshot.create({
        data: {
          projectId,
          diagram,
          version: BigInt(version),
          kind: 'named',
          name,
          createdBy: user.id,
          authors: [],
          sizeBytes,
        },
        select: metaSelect,
      });
    });

    return toSnapshotMeta(row);
  }

  async rename(
    projectId: string,
    snapshotId: string,
    name: string,
    user: PublicUser,
  ): Promise<SnapshotMeta> {
    await this.requireWrite(projectId, user);
    const { count } = await this.deps.prisma.projectSnapshot.updateMany({
      where: { id: snapshotId, projectId, kind: 'named' },
      data: { name },
    });
    if (count === 0) throw new AppError('not_found');
    const row = await this.deps.prisma.projectSnapshot.findUnique({
      where: { id: snapshotId },
      select: metaSelect,
    });
    if (!row) throw new AppError('not_found');
    return toSnapshotMeta(row);
  }

  async remove(projectId: string, snapshotId: string, user: PublicUser): Promise<void> {
    await this.requireWrite(projectId, user);
    const { count } = await this.deps.prisma.projectSnapshot.deleteMany({
      where: { id: snapshotId, projectId, kind: 'named' },
    });
    if (count === 0) throw new AppError('not_found');
  }

  async restore(
    projectId: string,
    snapshotId: string,
    user: PublicUser,
  ): Promise<{ version: number; epoch: number }> {
    await this.requireWrite(projectId, user);
    const snapshot = await this.deps.prisma.projectSnapshot.findFirst({
      where: { id: snapshotId, projectId },
      select: { diagram: true, createdAt: true },
    });
    if (!snapshot) throw new AppError('not_found');
    return this.deps.history.restore(
      projectId,
      snapshot.diagram,
      { id: user.id, name: user.name },
      snapshot.createdAt,
    );
  }
}
