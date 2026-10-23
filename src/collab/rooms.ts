import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { getSessionUser } from '../auth/sessions';
import type { PrismaClient } from '../db/prisma';
import type { Prisma } from '../generated/prisma/client';
import { isBulkDelete } from '../history/bulk-delete';
import { BULK_COOLDOWN_MS } from '../history/constants';
import type { Author } from '../history/types';
import { AppError } from '../http/app-error';
import { EMPTY_DOC } from '../projects/empty-doc';
import { getRole, type AccessRole } from '../projects/repo';
import { colorFor } from './colors';
import type { CollabHooks } from './hooks';
import { applyOps, COLLS, type Document, type Item, type Op } from './ops';

export type RoomManagerOptions = {
  saveDebounceMs?: number;
  snapshotIntervalMs?: number;
};

export type ApplyContext = {
  author?: Author;
  epoch?: number;
};

export type Peer = {
  userId: string;
  name: string;
  color: string;
};

export type AwarenessCursor = { x: number; y: number } | null;
export type AwarenessLinking = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
} | null;

export type SocketData = {
  sessionToken: string;
  user: PublicUser;
  projectId?: string;
  role?: AccessRole;
  awareness?: {
    cursor: AwarenessCursor;
    linking: AwarenessLinking;
  };
};

export type CollabSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

type RoomState = {
  projectId: string;
  name: string;
  doc: Document;
  version: number;
  savedVersion: number;
  epoch: number;
  authors: Map<string, string>;
  lastSnapshotAt: number | null;
  lastBulkSnapshotAt: number | null;
  timer: NodeJS.Timeout | null;
  saving: Promise<void> | null;
  deleted: boolean;
  touchSeq: number;
};

export function roomName(projectId: string): string {
  return `project:${projectId}`;
}

function normalizeDoc(raw: unknown): Document {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const doc: Document = {
    ...EMPTY_DOC,
    database: typeof source.database === 'string' ? source.database : EMPTY_DOC.database,
    sqlHeader: typeof source.sqlHeader === 'string' ? source.sqlHeader : EMPTY_DOC.sqlHeader,
  };
  for (const coll of COLLS) {
    doc[coll] = Array.isArray(source[coll]) ? (source[coll] as Item[]) : [];
  }
  return doc;
}

export class RoomManager implements CollabHooks {
  private readonly saveDebounceMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly rooms = new Map<string, RoomState>();
  private readonly loading = new Map<string, Promise<RoomState>>();
  private readonly deletedProjects = new Set<string>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private io: Server | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    opts: RoomManagerOptions = {},
  ) {
    this.saveDebounceMs = opts.saveDebounceMs ?? 2000;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? 600_000;
  }

  attachIo(io: Server): void {
    this.io = io;
  }

  getName(projectId: string): string | undefined {
    return this.rooms.get(projectId)?.name;
  }

  isActive(projectId: string): boolean {
    const room = this.rooms.get(projectId);
    return Boolean(room && !room.deleted && !this.deletedProjects.has(projectId));
  }

  getPeers(projectId: string): Peer[] {
    if (!this.io) return [];
    const ids = this.io.sockets.adapter.rooms.get(roomName(projectId));
    if (!ids) return [];
    const byUser = new Map<string, Peer>();
    for (const socketId of ids) {
      const socket = this.io.sockets.sockets.get(socketId) as CollabSocket | undefined;
      if (!socket?.connected || socket.data.projectId !== projectId || !socket.data.user) continue;
      const { id: userId, name } = socket.data.user;
      if (!byUser.has(userId)) {
        byUser.set(userId, { userId, name, color: colorFor(userId) });
      }
    }
    return [...byUser.values()];
  }

  getRoomSocketCount(projectId: string): number {
    if (!this.io) return 0;
    const ids = this.io.sockets.adapter.rooms.get(roomName(projectId));
    if (!ids) return 0;
    let count = 0;
    for (const socketId of ids) {
      const socket = this.io.sockets.sockets.get(socketId) as CollabSocket | undefined;
      if (socket?.connected && socket.data.projectId === projectId) count++;
    }
    return count;
  }

  async join(projectId: string): Promise<{ doc: Document; version: number; epoch: number }> {
    const room = await this.ensureRoom(projectId);
    room.touchSeq++;
    return { doc: room.doc, version: room.version, epoch: room.epoch };
  }

  apply(
    projectId: string,
    ops: readonly Op[],
    ctx?: ApplyContext,
  ): { applied: Op[]; version: number; ok: boolean; staleEpoch?: true } {
    const room = this.rooms.get(projectId);
    if (!room || room.deleted) {
      throw new AppError('not_found');
    }
    if (ctx?.epoch !== undefined && ctx.epoch !== room.epoch) {
      return { applied: [], version: room.version, ok: false, staleEpoch: true };
    }
    const now = Date.now();
    if (
      isBulkDelete(room.doc, ops) &&
      (room.lastBulkSnapshotAt === null || now - room.lastBulkSnapshotAt >= BULK_COOLDOWN_MS)
    ) {
      room.lastBulkSnapshotAt = now;
      const snapshotDoc = room.doc as Prisma.InputJsonValue;
      const snapshotVersion = room.version;
      const authors: Author[] = ctx?.author ? [ctx.author] : [];
      const sizeBytes = Buffer.byteLength(JSON.stringify(snapshotDoc));
      const writePromise = this.prisma.projectSnapshot
        .create({
          data: {
            projectId: room.projectId,
            diagram: snapshotDoc,
            version: BigInt(snapshotVersion),
            kind: 'pre_bulk_delete',
            authors,
            sizeBytes,
          },
        })
        .then(() => undefined)
        .catch((err: unknown) => {
          console.error(
            `Failed to create pre_bulk_delete snapshot for project ${room.projectId}:`,
            err,
          );
        })
        .finally(() => {
          this.pendingWrites.delete(writePromise);
        });
      this.pendingWrites.add(writePromise);
    }
    room.touchSeq++;
    const result = applyOps(room.doc, ops);
    if (result.applied.length > 0) {
      room.doc = result.doc;
      room.version += 1;
      if (ctx?.author) {
        room.authors.set(ctx.author.id, ctx.author.name);
      }
      this.scheduleSave(room);
    }
    return { applied: result.applied, version: room.version, ok: result.ok };
  }

  async flush(projectId: string): Promise<void> {
    const pendingLoad = this.loading.get(projectId);
    if (pendingLoad) {
      await pendingLoad.catch(() => undefined);
    }
    const room = this.rooms.get(projectId);
    if (!room) return;
    await this.flushRoom(room);
  }

  async flushAll(): Promise<void> {
    if (this.loading.size > 0) {
      await Promise.allSettled([...this.loading.values()]);
    }
    await Promise.all([...this.rooms.values()].map((room) => this.flushRoom(room)));
  }

  async idle(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  async release(projectId: string): Promise<void> {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const seqBeforeFlush = room.touchSeq;
    await this.flushRoom(room);
    if (
      this.rooms.get(projectId) === room &&
      room.touchSeq === seqBeforeFlush &&
      room.savedVersion === room.version &&
      !room.timer &&
      !room.saving &&
      this.getRoomSocketCount(projectId) === 0
    ) {
      this.rooms.delete(projectId);
    }
  }

  async onMembershipChanged(projectId: string, userId: string): Promise<void> {
    if (!this.io) return;
    const matching = this.findUserSocketsInProject(projectId, userId);
    if (matching.length === 0) return;

    const row = await this.prisma.user.findUnique({ where: { id: userId } });
    const user = row && row.emailVerifiedAt ? toPublicUser(row) : null;
    const role = user ? await getRole(this.prisma, projectId, user) : null;

    const currentSockets = this.findUserSocketsInProject(projectId, userId);
    if (currentSockets.length === 0) return;

    if (!user || !role) {
      for (const socket of currentSockets) {
        socket.data.projectId = undefined;
        socket.data.role = undefined;
        socket.data.awareness = undefined;
        void socket.leave(roomName(projectId));
        socket.emit('access_revoked');
        socket.disconnect(true);
      }
      const peers = this.getPeers(projectId);
      this.io.to(roomName(projectId)).emit('presence', { peers });
      if (this.getRoomSocketCount(projectId) === 0) {
        void this.release(projectId);
      }
      return;
    }

    for (const socket of currentSockets) {
      const prevRole = socket.data.role;
      socket.data.user = user;
      socket.data.role = role;
      if (prevRole !== role) {
        socket.emit('role_changed', { role });
      }
    }
  }

  async onUserRoleChanged(userId: string): Promise<void> {
    if (!this.io) return;
    const projectIds = new Set<string>();
    for (const raw of this.io.sockets.sockets.values()) {
      const socket = raw as CollabSocket;
      if (socket.connected && socket.data.user?.id === userId && socket.data.projectId) {
        projectIds.add(socket.data.projectId);
      }
    }
    await Promise.all(
      [...projectIds].map((projectId) => this.onMembershipChanged(projectId, userId)),
    );
  }

  async onSessionsChanged(userId: string): Promise<void> {
    if (!this.io) return;
    const sockets: CollabSocket[] = [];
    for (const raw of this.io.sockets.sockets.values()) {
      const socket = raw as CollabSocket;
      if (socket.connected && socket.data.user?.id === userId) {
        sockets.push(socket);
      }
    }
    for (const socket of sockets) {
      if (!socket.connected) continue;
      const validUser = await getSessionUser(this.prisma, socket.data.sessionToken);
      if (!validUser) {
        const pid = socket.data.projectId;
        if (pid) {
          socket.data.projectId = undefined;
          socket.data.role = undefined;
          socket.data.awareness = undefined;
          await socket.leave(roomName(pid));
          const peers = this.getPeers(pid);
          this.io.to(roomName(pid)).emit('presence', { peers });
          if (this.getRoomSocketCount(pid) === 0) {
            void this.release(pid);
          }
        }
        socket.emit('access_revoked');
        socket.disconnect(true);
      }
    }
  }

  onProjectRenamed(projectId: string, name: string): void {
    const room = this.rooms.get(projectId);
    if (room) {
      room.name = name;
    }
    this.io?.to(roomName(projectId)).emit('renamed', { name });
  }

  onProjectDeleted(projectId: string): void {
    this.deletedProjects.add(projectId);
    const room = this.rooms.get(projectId);
    if (room) {
      room.deleted = true;
      if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
      }
      this.rooms.delete(projectId);
    }
    if (!this.io) return;
    const rName = roomName(projectId);
    this.io.to(rName).emit('deleted');
    const ids = this.io.sockets.adapter.rooms.get(rName);
    if (!ids) return;
    for (const socketId of [...ids]) {
      const socket = this.io.sockets.sockets.get(socketId) as CollabSocket | undefined;
      if (!socket) continue;
      socket.data.projectId = undefined;
      socket.data.role = undefined;
      socket.data.awareness = undefined;
      void socket.leave(rName);
    }
  }

  private findUserSocketsInProject(projectId: string, userId: string): CollabSocket[] {
    if (!this.io) return [];
    const ids = this.io.sockets.adapter.rooms.get(roomName(projectId));
    if (!ids) return [];
    const result: CollabSocket[] = [];
    for (const socketId of ids) {
      const socket = this.io.sockets.sockets.get(socketId) as CollabSocket | undefined;
      if (
        socket?.connected &&
        socket.data.projectId === projectId &&
        socket.data.user?.id === userId
      ) {
        result.push(socket);
      }
    }
    return result;
  }

  private ensureRoom(projectId: string): Promise<RoomState> {
    if (this.deletedProjects.has(projectId)) {
      return Promise.reject(new Error('project_not_found'));
    }
    const existing = this.rooms.get(projectId);
    if (existing && !existing.deleted) {
      return Promise.resolve(existing);
    }
    const inflight = this.loading.get(projectId);
    if (inflight) {
      return inflight;
    }
    const loadPromise = (async () => {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, diagram: true, version: true },
      });
      if (this.deletedProjects.has(projectId)) {
        throw new Error('project_not_found');
      }
      if (!project) {
        throw new AppError('not_found');
      }
      const already = this.rooms.get(projectId);
      if (already && !already.deleted) {
        return already;
      }
      const version = Number(project.version);
      const room: RoomState = {
        projectId,
        name: project.name,
        doc: normalizeDoc(project.diagram),
        version,
        savedVersion: version,
        epoch: 0,
        authors: new Map(),
        lastSnapshotAt: null,
        lastBulkSnapshotAt: null,
        timer: null,
        saving: null,
        deleted: false,
        touchSeq: 0,
      };
      this.rooms.set(projectId, room);
      return room;
    })().finally(() => {
      this.loading.delete(projectId);
    });

    this.loading.set(projectId, loadPromise);
    return loadPromise;
  }

  private scheduleSave(room: RoomState): void {
    if (room.deleted) return;
    if (room.timer) {
      clearTimeout(room.timer);
    }
    room.timer = setTimeout(() => {
      room.timer = null;
      void this.flushRoom(room);
    }, this.saveDebounceMs);
  }

  private flushRoom(room: RoomState): Promise<void> {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    if (!room.saving) {
      room.saving = this.runSaveLoop(room).finally(() => {
        room.saving = null;
      });
    }
    return room.saving;
  }

  private async runSaveLoop(room: RoomState): Promise<void> {
    while (!room.deleted && room.savedVersion < room.version) {
      const targetDoc = room.doc as Prisma.InputJsonValue;
      const targetVersion = room.version;
      const now = Date.now();
      const takeSnapshot =
        room.lastSnapshotAt === null || now - room.lastSnapshotAt >= this.snapshotIntervalMs;
      let capturedAuthors: Map<string, string> | null = null;
      if (takeSnapshot) {
        capturedAuthors = room.authors;
        room.authors = new Map();
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.project.updateMany({
            where: { id: room.projectId },
            data: {
              diagram: targetDoc,
              version: BigInt(targetVersion),
              updatedAt: new Date(),
            },
          });
          if (count === 0) {
            room.deleted = true;
            return;
          }
          if (takeSnapshot && capturedAuthors) {
            const authors: Author[] = Array.from(capturedAuthors.entries(), ([id, name]) => ({
              id,
              name,
            }));
            const sizeBytes = Buffer.byteLength(JSON.stringify(targetDoc));
            await tx.projectSnapshot.create({
              data: {
                projectId: room.projectId,
                diagram: targetDoc,
                version: BigInt(targetVersion),
                kind: 'auto',
                authors,
                sizeBytes,
              },
            });
          }
        });
        if (!room.deleted) {
          room.savedVersion = targetVersion;
          if (takeSnapshot) {
            room.lastSnapshotAt = now;
          }
        }
      } catch (err) {
        if (capturedAuthors) {
          for (const [id, name] of capturedAuthors) {
            if (!room.authors.has(id)) {
              room.authors.set(id, name);
            }
          }
        }
        if (room.deleted) return;
        console.error(`Failed to persist project ${room.projectId}:`, err);
        break;
      }
    }
  }
}
