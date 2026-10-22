import http from 'http';
import { Server } from 'socket.io';
import { createApp, type AppDeps } from './app';

export function createServer(deps: AppDeps): { http: http.Server; io: Server } {
  const app = createApp(deps);
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 10 * 1024 * 1024 });
  return { http: httpServer, io };
}
