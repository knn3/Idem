import { Doc } from '@idem/crdt';
import type { Op } from '@idem/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Room } from '../src/rooms.js';
import { createMemoryStore, type OpStore } from '../src/store.js';

/** Snapshot every 4 ops, so a test crosses a boundary without typing 500 characters. */
const INTERVAL = 4;

function room(store: OpStore = createMemoryStore()): Promise<Room> {
  return Room.load('doc-1', store, { snapshotInterval: INTERVAL });
}

/** Ops for typing `text` left to right, as one client would produce them. */
function typeOps(replica: string, text: string): Op[] {
  const doc = new Doc(replica);
  return [...text].map((ch, i) => doc.localInsert(i, ch));
}

/** What a client ends up with after processing a `welcome` — the whole point of the message. */
function textAfterWelcome(welcome: ReturnType<Room['welcome']>): string {
  const doc = welcome.snapshot
    ? Doc.fromItems('client', welcome.snapshot.items)
    : new Doc('client');
  for (const op of welcome.ops) doc.apply(op);
  return doc.toString();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Room snapshots (M8)', () => {
  it('serves no snapshot before the interval is reached', async () => {
    const r = await room();
    r.applyOps(typeOps('a', 'HI'));
    const welcome = r.welcome(0);
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toHaveLength(2);
  });

  it('snapshots at the interval and serves it to a first-time client', async () => {
    const r = await room();
    r.applyOps(typeOps('a', 'ABCD'));

    const welcome = r.welcome(0);
    expect(welcome.snapshot?.seq).toBe(4);
    expect(welcome.seq).toBe(4);
    // The whole history is now in the snapshot, so the tail is empty — this is
    // the property that keeps a first connect cheap on a long document.
    expect(welcome.ops).toEqual([]);
    expect(textAfterWelcome(welcome)).toBe('ABCD');
  });

  it('serves snapshot plus tail once editing continues past the boundary', async () => {
    const r = await room();
    const ops = typeOps('a', 'ABCDEF');
    r.applyOps(ops.slice(0, 4));
    r.applyOps(ops.slice(4));

    const welcome = r.welcome(0);
    expect(welcome.snapshot?.seq).toBe(4);
    expect(welcome.ops).toHaveLength(2);
    expect(welcome.seq).toBe(6);
    expect(textAfterWelcome(welcome)).toBe('ABCDEF');
  });

  it('a client already past the snapshot gets the tail alone, no snapshot', async () => {
    const r = await room();
    const ops = typeOps('a', 'ABCDEF');
    r.applyOps(ops.slice(0, 4));
    r.applyOps(ops.slice(4));

    // sinceSeq 5 == caught up through the snapshot and one op beyond it.
    const welcome = r.welcome(5);
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toHaveLength(1);
    expect(welcome.seq).toBe(6);
  });

  it('a client exactly at the snapshot seq gets the tail alone', async () => {
    const r = await room();
    const ops = typeOps('a', 'ABCDEF');
    r.applyOps(ops.slice(0, 4));
    r.applyOps(ops.slice(4));

    const welcome = r.welcome(4);
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toHaveLength(2);
  });

  it('a snapshot carries tombstones, so a deleted document still converges', async () => {
    const doc = new Doc('a');
    const ops: Op[] = [...'ABCD'].map((ch, i) => doc.localInsert(i, ch));
    const del = doc.localDelete(1); // the 'B'
    expect(del).not.toBeNull();
    ops.push(del!);

    const r = await room();
    r.applyOps(ops);

    const welcome = r.welcome(0);
    expect(textAfterWelcome(welcome)).toBe('ACD');
    // Tombstones are never spliced out (hard rule 4) — a remote op may still
    // reference the deleted item as its origin.
    expect(welcome.snapshot?.items).toHaveLength(4);
  });

  it('hydrates from the snapshot after a restart, dedup intact for pre-snapshot ops', async () => {
    const store = createMemoryStore();
    const ops = typeOps('a', 'ABCDEF');
    const before = await room(store);
    // Two batches, so the restart has both a snapshot and a tail to recover.
    before.applyOps(ops.slice(0, 4));
    before.applyOps(ops.slice(4));
    await before.flush();

    // A fresh Room stands in for the process having restarted.
    const after = await room(store);
    const welcome = after.welcome(0);
    expect(welcome.snapshot?.seq).toBe(4);
    expect(welcome.seq).toBe(6);
    expect(textAfterWelcome(welcome)).toBe('ABCDEF');

    // The delete-op id problem in reverse: dedup after a restart is rebuilt
    // from the op log, not the snapshot, so an op from *before* the snapshot
    // is still recognized as a duplicate.
    expect(after.applyOps([ops[0]!])).toBeNull();
  });

  it('re-snapshots at each later boundary, building on the previous snapshot', async () => {
    const store = createMemoryStore();
    const r = await room(store);
    const ops = typeOps('a', 'ABCDEFGHIJKL');
    for (let i = 0; i < ops.length; i += INTERVAL) r.applyOps(ops.slice(i, i + INTERVAL));
    await r.flush();

    // Each snapshot is materialized from its predecessor plus the tail, never
    // by replaying from op 1 — the reason a long document stays cheap.
    // Only the newest is served; pruning of the older ones is a storage
    // concern, asserted against real Postgres in persistence.test.ts.
    expect((await store.latestSnapshot('doc-1'))?.seq).toBe(12);
    expect(textAfterWelcome(r.welcome(0))).toBe('ABCDEFGHIJKL');
  });

  it('checks the boundary once per batch, so one big batch takes one snapshot', async () => {
    const store = createMemoryStore();
    const r = await room(store);
    r.applyOps(typeOps('a', 'ABCDEFGHIJKL')); // 12 ops, one call
    await r.flush();

    expect((await store.latestSnapshot('doc-1'))?.seq).toBe(12);
    expect(r.welcome(0).ops).toEqual([]);
  });

  it('a snapshot never blocks the room: materialization failure is logged and skipped', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await room();

    // An op whose originLeft names an item the room has never seen — a causal
    // delivery violation. The schema accepts it, so only integration catches it.
    const orphan: Op = {
      kind: 'insert',
      id: { lamport: 1, replica: 'z' },
      originLeft: { lamport: 99, replica: 'ghost' },
      content: 'X',
    };
    const result = r.applyOps([...typeOps('a', 'ABC'), orphan]);

    // The room still assigned seq and is ready to broadcast — it is a relay.
    expect(result).toEqual({ seq: 4, ops: expect.any(Array) });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('snapshot materialization failed'),
      expect.anything(),
    );
    // No snapshot was taken, so catch-up falls back to the full log.
    const welcome = r.welcome(0);
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toHaveLength(4);
  });
});
