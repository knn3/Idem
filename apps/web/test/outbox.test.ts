import { Doc } from '@idem/crdt';
import { describe, expect, it } from 'vitest';

import { createMemoryOutbox, opKey } from '../app/sync/outbox';

/**
 * The in-memory outbox — the fallback implementation, and the one the sync
 * tests run against. Its IndexedDB twin is exercised for real in Chromium by
 * `e2e/offline.spec.ts`, which is the only place a browser database can be
 * tested honestly.
 */
describe('memory outbox', () => {
  const doc = new Doc('a');
  const ops = [...'abc'].map((char, index) => doc.localInsert(index, char));

  it('returns operations in creation order', async () => {
    const outbox = createMemoryOutbox();
    await outbox.add([ops[0]!]);
    await outbox.add([ops[1]!, ops[2]!]);
    // Order is load-bearing: an operation's originLeft may be an item an
    // earlier queued operation created, so replay has to follow creation order.
    expect((await outbox.all()).map((op) => opKey(op.id))).toEqual(ops.map((op) => opKey(op.id)));
  });

  it('removes only the acknowledged operations', async () => {
    const outbox = createMemoryOutbox();
    await outbox.add(ops);
    await outbox.ack([ops[1]!.id]);
    expect((await outbox.all()).map((op) => opKey(op.id))).toEqual([
      opKey(ops[0]!.id),
      opKey(ops[2]!.id),
    ]);
  });

  it('ignores an acknowledgement for an operation it does not hold', async () => {
    // The server broadcasts every accepted operation to every client, so most
    // acknowledgements a client sees are for other replicas' work.
    const outbox = createMemoryOutbox();
    await outbox.add([ops[0]!]);
    await outbox.ack([{ replica: 'someone-else', lamport: 1 }]);
    expect(await outbox.all()).toHaveLength(1);
  });

  it('does not queue the same operation twice', async () => {
    const outbox = createMemoryOutbox();
    await outbox.add([ops[0]!]);
    await outbox.add([ops[0]!]);
    expect(await outbox.all()).toHaveLength(1);
  });
});
