import http from 'http';
import { Server } from 'socket.io';
import { createApp, type AppDeps } from './app';
import { parseAiConfig } from './ai/config';
import { GenerationRegistry } from './ai/generation-registry';
import { RoomManager } from './collab/rooms';
import { registerCollab } from './collab/socket';

export type ServerDeps = Omit<AppDeps, 'rooms'> & {
  rooms?: RoomManager;
};

export function createServer(deps: ServerDeps): {
  http: http.Server;
  io: Server;
  rooms: RoomManager;
  shutdownAi: () => Promise<void>;
} {
  const rooms = deps.rooms ?? new RoomManager(deps.prisma);
  const aiConfig = deps.ai?.config ?? deps.config.ai ?? parseAiConfig({});
  const registry = deps.ai?.registry ?? new GenerationRegistry(aiConfig);
  const app = createApp({
    ...deps,
    rooms,
    history: rooms,
    ai: { ...deps.ai, config: aiConfig, registry },
  });
  const httpServer = http.createServer(app);
  const allowedOrigin = new URL(deps.config.appUrl).origin;
  const io = new Server(httpServer, {
    maxHttpBufferSize: 10e6,
    cors: {
      origin: allowedOrigin,
      credentials: true,
    },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) {
        callback('origin_not_allowed', false);
        return;
      }
      callback(null, true);
    },
  });
  registerCollab(io, { prisma: deps.prisma, rooms });
  return {
    http: httpServer,
    io,
    rooms,
    shutdownAi: () => registry.drainAll(),
  };
}

