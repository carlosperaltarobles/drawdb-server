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

export interface HistoryRooms {
  /** Documento vigente: el de memoria si la sala está cargada, si no el de la DB. */
  peekDoc(projectId: string): Promise<{ doc: unknown; version: number }>;
  restore(
    projectId: string,
    diagram: unknown,
    by: Author,
    snapshotCreatedAt: Date,
  ): Promise<{ version: number; epoch: number }>;
}
