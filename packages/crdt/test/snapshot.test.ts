import { describe, expect, it } from 'vitest';

import { Doc, type Op } from '../src/index.js';

/**
 * `Doc.fromItems` is the load path for a snapshot (SPEC §9, M8). Its contract
 * is that hydrating from a document's items is indistinguishable from having
 * replayed every op that produced them.
 */
function replay(replica: string, ops: readonly Op[]): Doc {
  const doc = new Doc(replica);
  for (const op of ops) doc.apply(op);
  return doc;
}

/** Types `text` at the end of a fresh doc and returns the ops. */
function typeOps(replica: string, text: string): Op[] {
  const doc = new Doc(replica);
  return [...text].map((ch, i) => doc.localInsert(i, ch));
}

describe('Doc.fromItems', () => {
  it('reproduces the text of the doc it was taken from', () => {
    const source = replay('a', typeOps('a', 'HELLO'));
    expect(Doc.fromItems('b', source.items).toString()).toBe('HELLO');
  });

  it('preserves tombstones, so item and visible index spaces both survive', () => {
    const ops = typeOps('a', 'HELLO');
    const source = replay('a', ops);
    expect(source.localDelete(1)).not.toBeNull(); // the 'E'

    const hydrated = Doc.fromItems('b', source.items);
    expect(hydrated.toString()).toBe('HLLO');
    // Tombstones are never spliced out (hard rule 4): the item list is longer
    // than the text, and that is exactly what keeps remote origins resolvable.
    expect(hydrated.items).toHaveLength(5);
    expect(hydrated.visibleItems()).toHaveLength(4);
  });

  it('a remote op still integrates against a hydrated doc', () => {
    const ops = typeOps('a', 'HELLO');
    const source = replay('a', ops);
    const hydrated = Doc.fromItems('b', source.items);

    // An op from a third replica whose originLeft is an item that only ever
    // reached `hydrated` through the snapshot.
    const author = replay('c', ops);
    const remote = author.localInsert(5, '!');

    expect(hydrated.apply(remote)).toBe(true);
    expect(hydrated.toString()).toBe('HELLO!');
  });

  it('an insert already in the snapshot is deduplicated, not applied twice', () => {
    const ops = typeOps('a', 'HI');
    const hydrated = Doc.fromItems('b', replay('a', ops).items);
    for (const op of ops) expect(hydrated.apply(op)).toBe(false);
    expect(hydrated.toString()).toBe('HI');
  });

  it('a delete already reflected in the snapshot re-applies as a harmless no-op', () => {
    const source = replay('a', typeOps('a', 'HI'));
    const del = source.localDelete(0)!;
    const hydrated = Doc.fromItems('b', source.items);

    // The delete op's own id is not recoverable from items, so `apply` does not
    // recognize it as seen — it runs integrateDelete again. Idempotent by hard
    // rule 5, so the text is unchanged.
    expect(hydrated.apply(del)).toBe(true);
    expect(hydrated.toString()).toBe('I');
  });

  it('seeds the clock above every item, so local ids do not collide with the past', () => {
    const source = replay('a', typeOps('a', 'HELLO'));
    const highest = Math.max(...source.items.map((item) => item.id.lamport));
    const op = Doc.fromItems('b', source.items).localInsert(5, '!');
    expect(op.id.lamport).toBe(highest + 1);
    expect(op.id.replica).toBe('b');
  });

  it('does not alias the caller’s items — deleting in one doc leaves the other alone', () => {
    const source = replay('a', typeOps('a', 'HI'));
    const hydrated = Doc.fromItems('b', source.items);
    hydrated.localDelete(0);
    expect(hydrated.toString()).toBe('I');
    expect(source.toString()).toBe('HI');
  });

  it('hydrating mid-history then applying the tail matches a full replay', () => {
    // The shape of a real catch-up: snapshot at op 3, four more ops after it.
    const author = new Doc('a');
    const all = [...'ABCDEFG'].map((ch, i) => author.localInsert(i, ch));

    const atSnapshot = replay('x', all.slice(0, 3));
    const hydrated = Doc.fromItems('y', atSnapshot.items);
    for (const op of all.slice(3)) hydrated.apply(op);

    expect(hydrated.toString()).toBe(replay('z', all).toString());
    expect(hydrated.toString()).toBe('ABCDEFG');
  });
});
