import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { HOST, PORT } from './env.js';

/**
 * The server does not resolve conflicts. It assigns a per-document sequence
 * number, appends to an immutable log, and rebroadcasts. All merging happens in
 * @idem/crdt, identically on every machine — the server is a relay with a disk,
 * not an authority.
 *
 * Rooms, seq assignment and broadcast arrive in M6 (IDE-11); persistence in M7.
 */
export function createServer() {
  const app = Fastify({ logger: true });

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
