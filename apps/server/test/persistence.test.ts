import type { AddressInfo } from 'node:net';

import { Doc } from '@idem/crdt';
import type { Op, ServerMessage } from '@idem/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDb, type Database } from '../src/db/client.js';
import { opLog, snapshot } from '../src/db/schema.js';
import { DEV_DOC_ID, ensureDevSeed } from '../src/dev-seed.js';
import { createServer } from '../src/index.js';
import { RoomRegistry } from '../src/rooms.js';
import { createPostgresStore } from '../src/store.js';

/**
 * Real-Postgres tests for M7's acceptance criterion (kill the server, restart
 * it, reload — the document is exactly as you left it) and for M8's snapshot
 * storage and pruning, which only a real database can check. Skipped
 * without `DATABASE_URL` (CI doesn't provision Postgres for this project;
 * SPEC targets Neon in production). Run locally against a scratch database:
 *
 *   docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=idem -p 5432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/idem pnpm db:push
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/idem pnpm --filter @idem/server exec vitest run test/persistence.test.ts
 */
describe.skipIf(!process.env.DATABASE_URL)('persistence (M7, M8)', () => {
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
    await db.delete(snapshot).where(eq(snapshot.docId, DEV_DOC_ID));
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

  it('stores snapshots at the interval and keeps only the two most recent (SPEC §9)', async () => {
    const store = createPostgresStore(db);
    const room = await new RoomRegistry(store, { snapshotInterval: 4 }).getOrCreate(DEV_DOC_ID);

    const author = new Doc('a');
    const ops = [...'ABCDEFGHIJKL'].map((ch, i) => author.localInsert(i, ch));
    for (let i = 0; i < ops.length; i += 4) room.applyOps(ops.slice(i, i + 4));
    await room.flush();

    // Three boundaries were crossed, but pruning leaves the newest two.
    const rows = await db
      .select({ seq: snapshot.seq })
      .from(snapshot)
      .where(eq(snapshot.docId, DEV_DOC_ID))
      .orderBy(asc(snapshot.seq));
    expect(rows.map((r) => r.seq)).toEqual([8, 12]);

    // And a restart hydrates from the newest one, not from op 1.
    const after = await new RoomRegistry(store, { snapshotInterval: 4 }).getOrCreate(DEV_DOC_ID);
    const welcome = after.welcome(0);
    expect(welcome.snapshot?.seq).toBe(12);
    expect(welcome.seq).toBe(12);
    expect(Doc.fromItems('fresh', welcome.snapshot!.items).toString()).toBe('ABCDEFGHIJKL');
  });
});
