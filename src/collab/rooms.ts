import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import type { PrismaClient } from '../db/prisma';
import type { Prisma } from '../generated/prisma/client';
import { AppError } from '../http/app-error';
import { EMPTY_DOC } from '../projects/empty-doc';
import { getRole, type AccessRole } from '../projects/repo';
import { colorFor } from './colors';
import type { CollabHooks } from './hooks';
import { applyOps, COLLS, type Document, type Item, type Op } from './ops';

export type RoomManagerOptions = {
  saveDebounceMs?: number;
  snapshotIntervalMs?: number;
  snapshotKeep?: number;
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
  lastSnapshotAt: number | null;
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
  private readonly snapshotKeep: number;
  private readonly rooms = new Map<string, RoomState>();
  private readonly loading = new Map<string, Promise<RoomState>>();
  private io: Server | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    opts: RoomManagerOptions = {},
  ) {
    this.saveDebounceMs = opts.saveDebounceMs ?? 2000;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? 600_000;
    this.snapshotKeep = opts.snapshotKeep ?? 200;
  }

  attachIo(io: Server): void {
    this.io = io;
  }

  getName(projectId: string): string | undefined {
    return this.rooms.get(projectId)?.name;
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

  async join(projectId: string): Promise<{ doc: Document; version: number }> {
    const room = await this.ensureRoom(projectId);
    room.touchSeq++;
    return { doc: room.doc, version: room.version };
  }

  apply(projectId: string, ops: readonly Op[]): { applied: Op[]; version: number; ok: boolean } {
    const room = this.rooms.get(projectId);
    if (!room || room.deleted) {
      throw new AppError('not_found');
    }
    room.touchSeq++;
    const result = applyOps(room.doc, ops);
    if (result.applied.length > 0) {
      room.doc = result.doc;
      room.version += 1;
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

  onProjectRenamed(projectId: string, name: string): void {
    const room = this.rooms.get(projectId);
    if (room) {
      room.name = name;
    }
    this.io?.to(roomName(projectId)).emit('renamed', { name });
  }

  onProjectDeleted(projectId: string): void {
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
        lastSnapshotAt: null,
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
        this.snapshotKeep > 0 &&
        (room.lastSnapshotAt === null || now - room.lastSnapshotAt >= this.snapshotIntervalMs);

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
          if (takeSnapshot) {
            await tx.projectSnapshot.create({
              data: {
                projectId: room.projectId,
                diagram: targetDoc,
                version: BigInt(targetVersion),
              },
            });
            const stale = await tx.projectSnapshot.findMany({
              where: { projectId: room.projectId },
              orderBy: [{ createdAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
              skip: this.snapshotKeep,
              select: { id: true },
            });
            if (stale.length > 0) {
              await tx.projectSnapshot.deleteMany({
                where: { id: { in: stale.map((s) => s.id) } },
              });
            }
          }
        });
        if (!room.deleted) {
          room.savedVersion = targetVersion;
          if (takeSnapshot) {
            room.lastSnapshotAt = now;
          }
        }
      } catch (err) {
        if (room.deleted) return;
        console.error(`Failed to persist project ${room.projectId}:`, err);
        break;
      }
    }
  }
}
