import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Doc, type Op } from '../src/index.js';

function replay(replica: string, ops: readonly Op[]): Doc {
  const doc = new Doc(replica);
  for (const op of ops) doc.apply(op);
  return doc;
}

/**
 * Builds a causally-valid linear op stream the way the real system does: the
 * server's `seq` order (SPEC §5). Each round lets several replicas each create
 * one op *before* any of them is delivered — so the stream contains genuinely
 * concurrent ops — then delivers that round to everyone in stream order.
 * Every op's dependencies therefore appear earlier in the stream, which is
 * exactly the guarantee a client replaying `welcome.ops` relies on.
 */
function buildStream(seed: number, nReplicas: number, nRounds: number): Op[] {
  let a = seed;
  const rnd = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const replicas = Array.from({ length: nReplicas }, (_, i) => new Doc(`r${i}`));
  const stream: Op[] = [];

  for (let round = 0; round < nRounds; round++) {
    const created: Op[] = [];
    for (const doc of replicas) {
      if (rnd() < 0.4) continue; // not every replica acts every round
      const visible = doc.visibleItems().length;
      if (visible > 0 && rnd() < 0.3) {
        const op = doc.localDelete(Math.floor(rnd() * visible));
        if (op) created.push(op);
      } else {
        const at = Math.floor(rnd() * (visible + 1));
        created.push(doc.localInsert(at, String.fromCharCode(97 + Math.floor(rnd() * 26))));
      }
    }
    for (const op of created) {
      stream.push(op);
      for (const doc of replicas) doc.apply(op); // idempotent for the author
    }
  }
  return stream;
}

describe('snapshot catch-up (property)', () => {
  it('snapshot at any point plus the tail equals a full replay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 5 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (seed, nReplicas, cutFraction) => {
          const stream = buildStream(seed, nReplicas, 30);
          fc.pre(stream.length > 0);
          const cut = Math.floor(cutFraction * stream.length);

          // The server takes a snapshot after `cut` ops...
          const atSnapshot = replay('server', stream.slice(0, cut));
          // ...and a fresh client hydrates from it, then applies the tail.
          const client = Doc.fromItems('client', atSnapshot.items);
          for (const op of stream.slice(cut)) client.apply(op);

          // A client with no snapshot replays everything. Both must agree.
          expect(client.toString()).toBe(replay('replayer', stream).toString());
        },
      ),
      { numRuns: 1000 },
    );
  });
});
