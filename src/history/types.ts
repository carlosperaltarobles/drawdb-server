import type { SnapshotKind } from '../generated/prisma/client';

export type Author = { id: string; name: string };

export type SnapshotMeta = {
  id: string;
  kind: SnapshotKind;
  name: string | null;
  createdAt: Date;
  createdBy: Author | null;
  authors: Author[];
  sizeBytes: number | null;
};
