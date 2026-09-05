import type { AddressInfo } from 'node:net';

import { Doc } from '@idem/crdt';
import { parseServerMessage, type Op } from '@idem/protocol';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createServer } from '../src/index.js';
import { Room } from '../src/rooms.js';
import { createMemoryStore, type OpStore } from '../src/store.js';

/**
 * M8's acceptance criterion: a document with 10,000 operations loads in a
 * fresh tab in under 500 ms. Measured end to end — `hello` on the wire through
 * zod validation of the whole payload and `Doc` hydration to rendered text —
 * because a server-side timer would hide the two costs that actually dominate:
 * validating ~10,000 items (hard rule 9) and integrating ops.
 *
 * The numbers this prints are recorded in docs/BENCHMARKS.md.
 */
const OP_COUNT = 10_000;
const BUDGET_MS = 500;

/** A realistic replica id — length matters, it is repeated twice per item on the wire. */
const AUTHOR = '9f2c1d84-3b7e-4a16-9c05-71ee8d2a4f30';

/**
 * 10,000 ops for typing left to right, built directly rather than through
 * `Doc.localInsert` — the shape is identical (each op's `originLeft` is the
 * previous character) and building them through a `Doc` would itself be
 * quadratic, which is the cost under test, not the setup.
 */
function typingOps(count: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({
      kind: 'insert',
      id: { lamport: i + 1, replica: AUTHOR },
      originLeft: i === 0 ? null : { lamport: i, replica: AUTHOR },
      content: String.fromCharCode(97 + (i % 26)),
    });
  }
  return ops;
}

/** Fills a room with `ops`, in realistic batch sizes, and returns it. */
async function seededRoom(store: OpStore, snapshotInterval?: number): Promise<Room> {
  const room = await Room.load(
    'bench',
    store,
    // Omitted rather than passed as undefined: `exactOptionalPropertyTypes`.
    snapshotInterval === undefined ? {} : { snapshotInterval },
  );
  const ops = typingOps(OP_COUNT);
  for (let i = 0; i < ops.length; i += 100) room.applyOps(ops.slice(i, i + 100));
  await room.flush();
  return room;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextRaw(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
}

describe(`loading a ${OP_COUNT.toLocaleString()}-operation document`, () => {
  it(`a fresh tab is rendering text in under ${BUDGET_MS} ms`, async () => {
    const store = createMemoryStore();
    await seededRoom(store); // fixture: the document's history, already persisted

    // A brand-new server, so the timed request also pays the server's own cold
    // room load — exactly what a fresh tab hits after a deploy or a restart.
    const app = createServer({ store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const ws = await connect(`ws://127.0.0.1:${port}/ws`);
    const started = performance.now();
    ws.send(JSON.stringify({ t: 'hello', docId: 'bench', replica: 'fresh-tab', sinceSeq: 0 }));
    const raw = await nextRaw(ws);

    // Everything a real tab does with the message, timed: validate, hydrate, render.
    const message = parseServerMessage(raw);
    expect(message.t).toBe('welcome');
    if (message.t !== 'welcome') throw new Error('unreachable');
    const doc = message.snapshot
      ? Doc.fromItems('fresh-tab', message.snapshot.items)
      : new Doc('fresh-tab');
    for (const op of message.ops) doc.apply(op);
    const text = doc.toString();
    const elapsed = performance.now() - started;

    expect(text).toHaveLength(OP_COUNT);
    console.log(
      `[M8] snapshot load of ${OP_COUNT.toLocaleString()} ops: ${elapsed.toFixed(1)} ms ` +
        `(payload ${(raw.length / 1024).toFixed(0)} KiB, snapshot=${String(message.snapshot !== null)}, tail=${message.ops.length})`,
    );

    ws.close();
    await app.close();

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('records the no-snapshot baseline the snapshot path replaces', async () => {
    // Same document, snapshots disabled: `welcome` carries all 10,000 ops and
    // the client integrates every one. This is what M8 exists to avoid.
    const store = createMemoryStore();
    await seededRoom(store, Number.POSITIVE_INFINITY);
    const room = await Room.load('bench', store, {
      snapshotInterval: Number.POSITIVE_INFINITY,
    });

    const started = performance.now();
    const raw = JSON.stringify(room.welcome(0));
    const message = parseServerMessage(raw);
    if (message.t !== 'welcome') throw new Error('unreachable');
    const doc = new Doc('fresh-tab');
    for (const op of message.ops) doc.apply(op);
    const elapsed = performance.now() - started;

    expect(doc.toString()).toHaveLength(OP_COUNT);
    expect(message.snapshot).toBeNull();
    console.log(
      `[M8] full replay of ${OP_COUNT.toLocaleString()} ops: ${elapsed.toFixed(1)} ms ` +
        `(payload ${(raw.length / 1024).toFixed(0)} KiB)`,
    );
  });
});
