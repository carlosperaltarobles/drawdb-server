import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { hashPassword } from '../src/auth/passwords';
import { createSession, destroySession, SESSION_COOKIE } from '../src/auth/sessions';
import { applyOps, type Document, type Op } from '../src/collab/ops';
import { config } from '../src/config';
import { getPrisma, type PrismaClient } from '../src/db/prisma';
import type { Prisma } from '../src/generated/prisma/client';
import { generateDiagram } from './gen-diagram';

export interface LoadTestOptions {
  projectId?: string;
  clients: number;
  seconds: number;
  url: string;
  cleanupSeeded?: boolean;
}

export interface LoadTestReport {
  projectId: string;
  clients: number;
  seconds: number;
  tables: number;
  relationships: number;
  totalOpsSent: number;
  totalOpsAcked: number;
  remoteOpsReceived: number;
  awarenessSent: number;
  awarenessReceived: number;
  resyncs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function parseCliArgs(argv: string[]): LoadTestOptions {
  let projectId: string | undefined;
  let clients = 10;
  let seconds = 60;
  let url = `http://localhost:${config.port}`;
  let cleanupSeeded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) {
      projectId = argv[++i];
    } else if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
    } else if (arg === '--clients' && argv[i + 1]) {
      clients = Math.max(1, Number.parseInt(argv[++i], 10) || 10);
    } else if (arg.startsWith('--clients=')) {
      clients = Math.max(1, Number.parseInt(arg.slice('--clients='.length), 10) || 10);
    } else if (arg === '--seconds' && argv[i + 1]) {
      seconds = Math.max(1, Number.parseFloat(argv[++i]) || 60);
    } else if (arg.startsWith('--seconds=')) {
      seconds = Math.max(1, Number.parseFloat(arg.slice('--seconds='.length)) || 60);
    } else if (arg === '--url' && argv[i + 1]) {
      url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg === '--cleanup') {
      cleanupSeeded = true;
    }
  }

  return { projectId, clients, seconds, url, cleanupSeeded };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function buildRandomOp(doc: Document, clientIndex: number, tick: number): Op {
  const tables = doc.tables ?? [];
  if (tables.length === 0) {
    return { t: 'set', key: 'sqlHeader', value: `-- tick ${tick} from client ${clientIndex}` };
  }
  const tableIdx = (clientIndex * 17 + tick) % tables.length;
  const table = tables[tableIdx];
  const fields = (table.fields as Array<{ id: string | number }> | undefined) ?? [];

  if (tick % 2 === 0 && fields.length > 0) {
    const field = fields[(clientIndex + tick) % fields.length];
    return {
      t: 'spatch',
      coll: 'tables',
      id: table.id,
      sub: 'fields',
      sid: field.id,
      patch: {
        comment: `Updated by loadtest+${clientIndex + 1} at tick ${tick}`,
      },
    };
  }

  const baseX = typeof table.x === 'number' ? table.x : (tableIdx % 15) * 320;
  const baseY = typeof table.y === 'number' ? table.y : Math.floor(tableIdx / 15) * 460;
  return {
    t: 'patch',
    coll: 'tables',
    id: table.id,
    patch: {
      x: baseX + ((tick % 5) - 2) * 4,
      y: baseY + (((tick + clientIndex) % 5) - 2) * 4,
    },
  };
}

type JoinSuccessResponse = {
  ok: true;
  name: string;
  role: string;
  version: number;
  doc: Document;
  peers: Array<{ userId: string; name: string; color: string }>;
};

type JoinResponse = JoinSuccessResponse | { ok: false; error: string };

function connectSocket(client: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      client.off('connect', onConnect);
      client.off('connect_error', onError);
    };
    client.on('connect', onConnect);
    client.on('connect_error', onError);
    client.connect();
  });
}

function joinRoom(client: ClientSocket, projectId: string): Promise<JoinResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join_timeout')), 10_000);
    client.emit('join', { projectId }, (res: JoinResponse) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export async function runLoadTest(
  opts: LoadTestOptions,
  prismaClient?: PrismaClient,
): Promise<LoadTestReport> {
  const prisma = prismaClient ?? getPrisma();
  const shouldDisconnectPrisma = !prismaClient;
  const domain = config.allowedDomains[0] || 'example.com';
  const passwordHash = await hashPassword('loadtest-pass-123');
  const origin = new URL(config.appUrl).origin;

  let createdTempProject = false;
  let targetProjectId = opts.projectId;
  const sessionTokens: string[] = [];
  const seededUserIds: string[] = [];
  const sockets: ClientSocket[] = [];

  try {
    if (!targetProjectId) {
      const generated = generateDiagram(200) as unknown as Prisma.InputJsonValue;
      const created = await prisma.project.create({
        data: {
          name: 'Load Test 200 Entities',
          diagram: generated,
        },
      });
      targetProjectId = created.id;
      createdTempProject = true;
    } else {
      const existing = await prisma.project.findUnique({
        where: { id: targetProjectId },
        select: { id: true, diagram: true },
      });
      if (!existing) {
        const generated = generateDiagram(200) as unknown as Prisma.InputJsonValue;
        await prisma.project.create({
          data: {
            id: targetProjectId,
            name: 'Load Test 200 Entities',
            diagram: generated,
          },
        });
        createdTempProject = true;
      } else {
        const rawDoc = existing.diagram as Record<string, unknown> | null;
        const tables = Array.isArray(rawDoc?.tables) ? rawDoc.tables : [];
        if (tables.length === 0) {
          const generated = generateDiagram(200) as unknown as Prisma.InputJsonValue;
          await prisma.project.update({
            where: { id: targetProjectId },
            data: { diagram: generated },
          });
        }
      }
    }

    const activeProjectId = targetProjectId;

    for (let i = 1; i <= opts.clients; i++) {
      const email = `loadtest+${i}@${domain}`.toLowerCase();
      const user = await prisma.user.upsert({
        where: { email },
        update: {
          name: `Load Test ${i}`,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
        create: {
          email,
          name: `Load Test ${i}`,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
      });
      seededUserIds.push(user.id);

      await prisma.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: targetProjectId,
            userId: user.id,
          },
        },
        update: { role: 'editor' },
        create: {
          projectId: targetProjectId,
          userId: user.id,
          role: 'editor',
        },
      });

      const token = await createSession(prisma, user.id);
      sessionTokens.push(token);
    }

    const ackLatencies: number[] = [];
    let totalOpsSent = 0;
    let totalOpsAcked = 0;
    let remoteOpsReceived = 0;
    let awarenessSent = 0;
    let awarenessReceived = 0;
    let resyncs = 0;

    interface ClientState {
      index: number;
      socket: ClientSocket;
      doc: Document;
      version: number;
      seq: number;
      pendingSentAt: Map<number, number>;
      resyncing: boolean;
    }

    const clientStates: ClientState[] = [];

    for (let i = 0; i < opts.clients; i++) {
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionTokens[i])}`;
      const socket = createClient(opts.url, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        extraHeaders: {
          Cookie: cookie,
          Origin: origin,
        },
      });
      sockets.push(socket);
      await connectSocket(socket);
      const joined = await joinRoom(socket, targetProjectId);
      if (!joined.ok) {
        throw new Error(`Client ${i + 1} failed to join room: ${joined.error}`);
      }

      const state: ClientState = {
        index: i,
        socket,
        doc: joined.doc,
        version: joined.version,
        seq: 0,
        pendingSentAt: new Map(),
        resyncing: false,
      };

      const triggerResync = () => {
        resyncs++;
        if (state.resyncing || !socket.connected) return;
        state.resyncing = true;
        state.pendingSentAt.clear();
        void joinRoom(socket, activeProjectId)
          .then((res) => {
            if (res.ok) {
              state.doc = res.doc;
              state.version = res.version;
            }
          })
          .catch(() => {})
          .finally(() => {
            state.resyncing = false;
          });
      };

      socket.on('resync', () => {
        triggerResync();
      });

      socket.on('ops', (payload: { version: number; ops: Op[] }) => {
        if (state.resyncing) return;
        if (payload.version !== state.version + 1) {
          triggerResync();
          return;
        }
        const applied = applyOps(state.doc, payload.ops);
        if (!applied.ok) {
          triggerResync();
          return;
        }
        state.doc = applied.doc;
        state.version = payload.version;
        remoteOpsReceived += payload.ops.length;
      });

      socket.on('ack', (payload: { seq: number; version?: number; ok: boolean }) => {
        const sentAt = state.pendingSentAt.get(payload.seq);
        if (sentAt !== undefined) {
          state.pendingSentAt.delete(payload.seq);
          ackLatencies.push(performance.now() - sentAt);
        }
        if (state.resyncing) return;
        if (
          !payload.ok ||
          typeof payload.version !== 'number' ||
          payload.version !== state.version + 1
        ) {
          triggerResync();
          return;
        }
        state.version = payload.version;
        totalOpsAcked++;
      });

      socket.on('awareness', () => {
        awarenessReceived++;
      });

      clientStates.push(state);
    }

    const initialDoc = clientStates[0]?.doc;
    const tableCount = initialDoc?.tables?.length ?? 0;
    const relationshipCount = initialDoc?.relationships?.length ?? 0;

    let awarenessTick = 0;
    let opsTick = 0;

    const awarenessTimer = setInterval(() => {
      awarenessTick++;
      for (const state of clientStates) {
        if (!state.socket.connected) continue;
        const angle = (awarenessTick + state.index * 10) * 0.15;
        const x = Math.round(500 + Math.cos(angle) * 300);
        const y = Math.round(400 + Math.sin(angle) * 300);
        state.socket.emit('awareness', {
          cursor: { x, y },
          linking: null,
        });
        awarenessSent++;
      }
    }, 50);

    const opsTimer = setInterval(() => {
      opsTick++;
      for (const state of clientStates) {
        if (!state.socket.connected || state.resyncing) continue;
        const op = buildRandomOp(state.doc, state.index, opsTick);
        const applied = applyOps(state.doc, [op]);
        state.doc = applied.doc;
        const seq = ++state.seq;
        state.pendingSentAt.set(seq, performance.now());
        totalOpsSent++;
        state.socket.emit('ops', { seq, ops: [op] });
      }
    }, 500);

    await new Promise<void>((resolve) => setTimeout(resolve, opts.seconds * 1000));

    clearInterval(awarenessTimer);
    clearInterval(opsTimer);

    const drainDeadline = Date.now() + 2000;
    while (Date.now() < drainDeadline && clientStates.some((c) => c.pendingSentAt.size > 0)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    for (const s of sockets) {
      s.disconnect();
    }
    sockets.length = 0;

    const sortedLatencies = [...ackLatencies].sort((a, b) => a - b);
    const p50Ms = percentile(sortedLatencies, 50);
    const p95Ms = percentile(sortedLatencies, 95);
    const maxMs =
      sortedLatencies.length > 0
        ? Number(sortedLatencies[sortedLatencies.length - 1].toFixed(2))
        : 0;

    return {
      projectId: targetProjectId,
      clients: opts.clients,
      seconds: opts.seconds,
      tables: tableCount,
      relationships: relationshipCount,
      totalOpsSent,
      totalOpsAcked,
      remoteOpsReceived,
      awarenessSent,
      awarenessReceived,
      resyncs,
      p50Ms,
      p95Ms,
      maxMs,
    };
  } finally {
    for (const s of sockets) {
      s.disconnect();
    }
    for (const token of sessionTokens) {
      await destroySession(prisma, token).catch(() => {});
    }
    if (createdTempProject && targetProjectId) {
      await prisma.project.deleteMany({ where: { id: targetProjectId } }).catch(() => {});
    }
    if (opts.cleanupSeeded && seededUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: seededUserIds } } }).catch(() => {});
    }
    if (shouldDisconnectPrisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  runLoadTest(opts)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.resyncs > 0 || report.p95Ms >= 150) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
