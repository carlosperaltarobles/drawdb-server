import type { Server } from 'socket.io';
import { z } from 'zod';
import { getSessionUser, SESSION_COOKIE } from '../auth/sessions';
import type { PrismaClient } from '../db/prisma';
import { getRole } from '../projects/repo';
import {
  roomName,
  type AwarenessCursor,
  type AwarenessLinking,
  type CollabSocket,
  type RoomManager,
} from './rooms';
import { validateOps } from './validate';

export type CollabDeps = {
  prisma: PrismaClient;
  rooms: RoomManager;
};

const uuidSchema = z.uuid();
const AWARENESS_WINDOW_MS = 1000;
const AWARENESS_MAX_PER_WINDOW = 20;
const AWARENESS_AUTH_TTL_MS = 2000;

export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex < 0) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name !== SESSION_COOKIE) continue;
    const rawValue = part.slice(eqIndex + 1).trim();
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeAwareness(
  input: unknown,
  current: { cursor: AwarenessCursor; linking: AwarenessLinking },
): { cursor: AwarenessCursor; linking: AwarenessLinking } | null {
  if (!isPlainObject(input)) return null;
  const hasCursor = Object.prototype.hasOwnProperty.call(input, 'cursor');
  const hasLinking = Object.prototype.hasOwnProperty.call(input, 'linking');
  if (!hasCursor && !hasLinking) return null;

  let cursor = current.cursor;
  if (hasCursor) {
    const rawCursor = input.cursor;
    if (rawCursor === null) {
      cursor = null;
    } else if (
      isPlainObject(rawCursor) &&
      isFiniteNumber(rawCursor.x) &&
      isFiniteNumber(rawCursor.y)
    ) {
      cursor = { x: rawCursor.x, y: rawCursor.y };
    } else {
      return null;
    }
  }

  let linking = current.linking;
  if (hasLinking) {
    const rawLinking = input.linking;
    if (rawLinking === null) {
      linking = null;
    } else if (
      isPlainObject(rawLinking) &&
      isFiniteNumber(rawLinking.startX) &&
      isFiniteNumber(rawLinking.startY) &&
      isFiniteNumber(rawLinking.endX) &&
      isFiniteNumber(rawLinking.endY)
    ) {
      linking = {
        startX: rawLinking.startX,
        startY: rawLinking.startY,
        endX: rawLinking.endX,
        endY: rawLinking.endY,
      };
    } else {
      return null;
    }
  }

  return { cursor, linking };
}

export function registerCollab(io: Server, { prisma, rooms }: CollabDeps): void {
  rooms.attachIo(io);

  io.use(async (rawSocket, next) => {
    const socket = rawSocket as CollabSocket;
    try {
      const token = parseSessionCookie(socket.handshake.headers.cookie);
      if (!token) {
        next(new Error('unauthorized'));
        return;
      }
      const user = await getSessionUser(prisma, token);
      if (!user) {
        next(new Error('unauthorized'));
        return;
      }
      socket.data.sessionToken = token;
      socket.data.user = user;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('unauthorized'));
    }
  });

  const leaveCurrentRoom = async (socket: CollabSocket): Promise<void> => {
    const prevProjectId = socket.data.projectId;
    if (!prevProjectId) return;
    socket.data.projectId = undefined;
    socket.data.role = undefined;
    socket.data.awareness = undefined;
    await socket.leave(roomName(prevProjectId));
    const peers = rooms.getPeers(prevProjectId);
    io.to(roomName(prevProjectId)).emit('presence', { peers });
    if (rooms.getRoomSocketCount(prevProjectId) === 0) {
      void rooms.release(prevProjectId);
    }
  };

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as CollabSocket;
    let queue = Promise.resolve();
    const awarenessTimestamps: number[] = [];
    let lastAuthCheckAt = Date.now();
    let awarenessAuthInFlight = false;

    const enqueue = (task: () => Promise<void>): void => {
      queue = queue.then(task).catch((err) => {
        console.error('Socket task error:', err);
      });
    };

    socket.on('join', (payload: unknown, ack?: (res: Record<string, unknown>) => void) => {
      const reply = typeof ack === 'function' ? ack : undefined;
      enqueue(async () => {
        if (!socket.connected) return;
        const rawProjectId = isPlainObject(payload) ? payload.projectId : undefined;
        const parsedId = uuidSchema.safeParse(rawProjectId);
        if (!parsedId.success) {
          await leaveCurrentRoom(socket);
          reply?.({ ok: false, error: 'not_found' });
          return;
        }
        const projectId = parsedId.data;

        const user = await getSessionUser(prisma, socket.data.sessionToken);
        if (!user) {
          await leaveCurrentRoom(socket);
          reply?.({ ok: false, error: 'unauthorized' });
          socket.emit('access_revoked');
          socket.disconnect(true);
          return;
        }
        socket.data.user = user;

        const [project, role] = await Promise.all([
          prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
          getRole(prisma, projectId, user),
        ]);
        if (!project || !role) {
          await leaveCurrentRoom(socket);
          reply?.({ ok: false, error: 'not_found' });
          return;
        }
        lastAuthCheckAt = Date.now();

        if (socket.data.projectId && socket.data.projectId !== projectId) {
          await leaveCurrentRoom(socket);
        }

        let joined: { doc: unknown; version: number };
        try {
          joined = await rooms.join(projectId);
        } catch {
          await leaveCurrentRoom(socket);
          reply?.({ ok: false, error: 'not_found' });
          return;
        }

        if (!socket.connected) {
          if (rooms.getRoomSocketCount(projectId) === 0) {
            void rooms.release(projectId);
          }
          return;
        }

        socket.data.projectId = projectId;
        socket.data.role = role;
        socket.data.awareness = { cursor: null, linking: null };
        await socket.join(roomName(projectId));

        const currentUser = await getSessionUser(prisma, socket.data.sessionToken);
        if (!currentUser) {
          await leaveCurrentRoom(socket);
          reply?.({ ok: false, error: 'not_found' });
          socket.emit('access_revoked');
          socket.disconnect(true);
          return;
        }
        socket.data.user = currentUser;

        const currentRole = await getRole(prisma, projectId, currentUser);
        if (
          !currentRole ||
          !rooms.isActive(projectId) ||
          socket.data.projectId !== projectId
        ) {
          await leaveCurrentRoom(socket);
          if (rooms.getRoomSocketCount(projectId) === 0) {
            void rooms.release(projectId);
          }
          reply?.({ ok: false, error: 'not_found' });
          return;
        }
        if (!socket.connected) {
          await leaveCurrentRoom(socket);
          if (rooms.getRoomSocketCount(projectId) === 0) {
            void rooms.release(projectId);
          }
          return;
        }
        socket.data.role = currentRole;
        lastAuthCheckAt = Date.now();

        const peers = rooms.getPeers(projectId);
        const name = rooms.getName(projectId) ?? project.name;
        reply?.({
          ok: true,
          doc: joined.doc,
          version: joined.version,
          role: currentRole,
          name,
          peers,
        });
        io.to(roomName(projectId)).emit('presence', { peers });
      });
    });

    socket.on('ops', (payload: unknown) => {
      enqueue(async () => {
        if (!socket.connected) return;
        const projectId = socket.data.projectId;
        if (!projectId || !isPlainObject(payload)) return;
        const seq = payload.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return;

        const validOps = validateOps(payload.ops);
        if (!validOps) {
          socket.emit('ack', { seq, ok: false, error: 'invalid_ops' });
          return;
        }

        const user = await getSessionUser(prisma, socket.data.sessionToken);
        if (!user) {
          await leaveCurrentRoom(socket);
          socket.emit('ack', { seq, ok: false, error: 'unauthorized' });
          socket.emit('access_revoked');
          socket.disconnect(true);
          return;
        }
        socket.data.user = user;
        if (!socket.connected || socket.data.projectId !== projectId) return;

        const role = await getRole(prisma, projectId, user);
        if (!socket.connected || socket.data.projectId !== projectId) return;
        if (!role) {
          await leaveCurrentRoom(socket);
          socket.emit('ack', { seq, ok: false, error: 'forbidden' });
          socket.emit('access_revoked');
          socket.disconnect(true);
          return;
        }
        socket.data.role = role;
        lastAuthCheckAt = Date.now();

        if (role === 'viewer') {
          socket.emit('ack', { seq, ok: false, error: 'forbidden' });
          return;
        }

        try {
          const { applied, version, ok } = rooms.apply(projectId, validOps);
          socket.emit('ack', { seq, version, ok });
          if (applied.length > 0) {
            socket.to(roomName(projectId)).emit('ops', {
              version,
              ops: applied,
              by: user.id,
            });
          }
        } catch {
          socket.emit('ack', { seq, ok: false, error: 'not_found' });
        }
      });
    });

    socket.on('awareness', (payload: unknown) => {
      const now = Date.now();
      while (
        awarenessTimestamps.length > 0 &&
        now - awarenessTimestamps[0] >= AWARENESS_WINDOW_MS
      ) {
        awarenessTimestamps.shift();
      }
      if (awarenessTimestamps.length >= AWARENESS_MAX_PER_WINDOW) return;
      awarenessTimestamps.push(now);

      if (!socket.connected) return;
      const projectId = socket.data.projectId;
      if (!projectId || !socket.data.role) return;

      const current = socket.data.awareness ?? { cursor: null, linking: null };
      const nextAwareness = sanitizeAwareness(payload, current);
      if (!nextAwareness) return;

      socket.data.awareness = nextAwareness;

      socket.volatile.to(roomName(projectId)).emit('awareness', {
        userId: socket.data.user.id,
        cursor: nextAwareness.cursor,
        linking: nextAwareness.linking,
      });

      if (now - lastAuthCheckAt >= AWARENESS_AUTH_TTL_MS && !awarenessAuthInFlight) {
        awarenessAuthInFlight = true;
        void (async () => {
          try {
            const user = await getSessionUser(prisma, socket.data.sessionToken);
            if (!user) {
              enqueue(async () => {
                if (!socket.connected) return;
                await leaveCurrentRoom(socket);
                socket.emit('access_revoked');
                socket.disconnect(true);
              });
              return;
            }
            socket.data.user = user;
            if (!socket.connected || socket.data.projectId !== projectId) return;
            const role = await getRole(prisma, projectId, user);
            if (!socket.connected || socket.data.projectId !== projectId) return;
            if (!role) {
              enqueue(async () => {
                if (!socket.connected || socket.data.projectId !== projectId) return;
                await leaveCurrentRoom(socket);
                socket.emit('access_revoked');
                socket.disconnect(true);
              });
              return;
            }
            socket.data.role = role;
            lastAuthCheckAt = Date.now();
          } catch (err) {
            console.error('Socket awareness auth check error:', err);
          } finally {
            awarenessAuthInFlight = false;
          }
        })();
      }
    });

    socket.on('disconnect', () => {
      enqueue(async () => {
        await leaveCurrentRoom(socket);
      });
    });
  });
}
