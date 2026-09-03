import type { AddressInfo } from 'node:net';

import type { Op, ServerMessage } from '@idem/protocol';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDb, type Database } from '../src/db/client.js';
import { opLog } from '../src/db/schema.js';
import { DEV_DOC_ID, ensureDevSeed } from '../src/dev-seed.js';
import { createServer } from '../src/index.js';
import { RoomRegistry } from '../src/rooms.js';
import { createPostgresStore } from '../src/store.js';

/**
 * Real-Postgres tests for M7's acceptance criterion: kill the server,
 * restart it, reload — the document is exactly as you left it. Skipped
 * without `DATABASE_URL` (CI doesn't provision Postgres for this project;
 * SPEC targets Neon in production). Run locally against a scratch database:
 *
 *   docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=idem -p 5432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/idem pnpm db:push
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/idem pnpm --filter @idem/server exec vitest run test/persistence.test.ts
 */
describe.skipIf(!process.env.DATABASE_URL)('op_log persistence (M7)', () => {
  let db: Database;
  let client: ReturnType<typeof createDb>['client'];

  beforeAll(() => {
    ({ db, client } = createDb());
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await ensureDevSeed(db);
    await db.delete(opLog).where(eq(opLog.docId, DEV_DOC_ID));
  });

  const insert = (lamport: number, replica: string, content: string): Op => ({
    kind: 'insert',
    id: { lamport, replica },
    originLeft: null,
    content,
  });

  it('a room loaded after a restart sees exactly what was persisted before it', async () => {
    const roomBefore = await new RoomRegistry(createPostgresStore(db)).getOrCreate(DEV_DOC_ID);
    roomBefore.applyOps([insert(1, 'a', 'H'), insert(2, 'a', 'I')]);
    await roomBefore.flush();

    // A fresh registry and store stand in for the process having restarted.
    const roomAfter = await new RoomRegistry(createPostgresStore(db)).getOrCreate(DEV_DOC_ID);
    expect(roomAfter.welcome(0)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });
  });

  it('end to end: kill the ws server, restart it, and a fresh tab gets the same document', async () => {
    const sockets: WebSocket[] = [];
    const connect = (url: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        sockets.push(ws);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });
    const nextMessage = (ws: WebSocket) =>
      new Promise<ServerMessage>((resolve, reject) => {
        ws.once('message', (data) => {
          try {
            resolve(JSON.parse(data.toString()) as ServerMessage);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

    // "Server process, run 1."
    let app = createServer({ store: createPostgresStore(db) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    let { port } = app.server.address() as AddressInfo;

    const a = await connect(`ws://127.0.0.1:${port}/ws`);
    a.send(JSON.stringify({ t: 'hello', docId: DEV_DOC_ID, replica: 'a', sinceSeq: 0 }));
    await nextMessage(a);
    a.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')] }));
    await nextMessage(a);

    // Give the fire-and-forget append a moment before we "kill -9" the process.
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await app.close(); // the kill

    // "Server process, run 2" — brand-new app, brand-new in-memory rooms, same database.
    app = createServer({ store: createPostgresStore(db) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    ({ port } = app.server.address() as AddressInfo);

    const b = await connect(`ws://127.0.0.1:${port}/ws`); // the reload
    b.send(JSON.stringify({ t: 'hello', docId: DEV_DOC_ID, replica: 'b', sinceSeq: 0 }));
    expect(await nextMessage(b)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });

    for (const ws of sockets) ws.close();
    await app.close();
  });
});
