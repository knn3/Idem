import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';

import { HOST, PORT } from './env.js';
import { RoomRegistry } from './rooms.js';
import { handleConnection } from './ws-handler.js';

/**
 * The server does not resolve conflicts. It assigns a per-document sequence
 * number, appends to an immutable log, and rebroadcasts. All merging happens in
 * @idem/crdt, identically on every machine — the server is a relay with a disk,
 * not an authority.
 *
 * WebSocket rooms live in-memory only (M6/IDE-11); persistence arrives in M7.
 * Fastify has no built-in ws support, so the `ws` server runs in `noServer`
 * mode and attaches itself to Fastify's raw HTTP server's `upgrade` event —
 * the standard way to combine the two without an extra plugin dependency.
 */
export function createServer() {
  const app = Fastify({ logger: true });
  const registry = new RoomRegistry();
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => handleConnection(ws, registry));

  app.server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '', 'http://internal');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  app.get('/health', () => ({ ok: true }));

  return app;
}

// Only listen when run directly, so tests can import createServer freely.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createServer();
  app.listen({ port: PORT, host: HOST }).catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
}
