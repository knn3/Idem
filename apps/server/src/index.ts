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
export interface ServerOptions {
  readonly store?: OpStore;
  /**
   * Proves the durable store is reachable and says which database answered.
   * Omitted when the server runs on an in-memory store, which has nothing to
   * probe.
   */
  readonly probeDatabase?: () => Promise<string>;
}

export function createServer(options: ServerOptions = {}) {
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

  /**
   * Liveness *and* the identity of the database behind it.
   *
   * An unconditional `{ ok: true }` here is worse than no endpoint at all: a
   * process whose database has gone away still answers it, so a health-gated
   * test run will happily proceed against a server that cannot persist
   * anything. This one round-trips to Postgres and reports which database
   * replied, which is what lets a caller tell "the server I meant to start"
   * from "some server that happens to hold this port".
   */
  app.get('/health', async (_request, reply) => {
    if (!options.probeDatabase) return { ok: true, database: null };
    try {
      return { ok: true, database: await options.probeDatabase() };
    } catch (error: unknown) {
      app.log.error(error);
      return reply.code(503).send({
        ok: false,
        database: null,
        code: 'E_DATABASE_UNREACHABLE',
        message:
          'The server is running but cannot reach its database. Check DATABASE_URL and that Postgres is up.',
      });
    }
  });

  return app;
}

// Only listen when run directly, so tests can import createServer freely.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, client } = createDb();
  const app = createServer({
    store: createPostgresStore(db),
    probeDatabase: async () => {
      const [row] = await client<{ name: string }[]>`select current_database() as name`;
      // Non-null: `select current_database()` always returns exactly one row.
      return row!.name;
    },
  });
  ensureDevSeed(db)
    .then(() => app.listen({ port: PORT, host: HOST }))
    .catch((error: unknown) => {
      app.log.error(error);
      process.exit(1);
    });
}
