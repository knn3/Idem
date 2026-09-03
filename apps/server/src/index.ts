import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';

import { createDb } from './db/client.js';
import { ensureDevSeed } from './dev-seed.js';
import { HOST, PORT } from './env.js';
import { RoomRegistry } from './rooms.js';
import { createLazyPostgresStore, createPostgresStore, type OpStore } from './store.js';
import { handleConnection } from './ws-handler.js';

/**
 * The server does not resolve conflicts. It assigns a per-document sequence
 * number, appends to an immutable log, and rebroadcasts. All merging happens in
 * @idem/crdt, identically on every machine — the server is a relay with a disk,
 * not an authority.
 *
 * WebSocket rooms live in memory but persist to Postgres via `op_log`
 * (M7/IDE-12) — a restart reloads each room from the database on its first
 * `hello`. Fastify has no built-in ws support, so the `ws` server runs in
 * `noServer` mode and attaches itself to Fastify's raw HTTP server's
 * `upgrade` event — the standard way to combine the two without an extra
 * plugin dependency.
 */
export function createServer(options: { store?: OpStore } = {}) {
  const app = Fastify({ logger: true });
  // Deferred so a `/health`-only caller (or a test that never sends `hello`)
  // never needs DATABASE_URL set.
  const store = options.store ?? createLazyPostgresStore(() => createDb().db);
  const registry = new RoomRegistry(store);
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
  const { db } = createDb();
  const app = createServer({ store: createPostgresStore(db) });
  ensureDevSeed(db)
    .then(() => app.listen({ port: PORT, host: HOST }))
    .catch((error: unknown) => {
      app.log.error(error);
      process.exit(1);
    });
}
