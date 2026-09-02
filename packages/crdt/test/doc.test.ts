import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc.js';
// The oracle: a verified, dependency-free reference implementation of the
// exact same SPEC §3 algorithm. If this Doc ever disagrees with it, this
// Doc is wrong — see docs/reference/rga-harness.mjs and PLAN.md M1.
import { Doc as OracleDoc } from '../../../docs/reference/rga-harness.mjs';

describe('Doc — local edits, single replica', () => {
  it('localInsert then localDelete round-trips through toString', () => {
    const doc = new Doc('A');
    doc.localInsert(0, 'h');
    doc.localInsert(1, 'i');
    expect(doc.toString()).toBe('hi');
    doc.localDelete(0);
    expect(doc.toString()).toBe('i');
  });
});

describe('Doc — concurrency (PLAN.md M1 acceptance criteria)', () => {
  it('two replicas inserting concurrently at the same position converge', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    const seed = a.localInsert(0, 'X');
    b.apply(seed);

    // Both insert at visible index 1 — same originLeft — without seeing the other yet.
    const opA = a.localInsert(1, 'A');
    const opB = b.localInsert(1, 'B');

    a.apply(opB);
    b.apply(opA);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toHaveLength(3);
  });

  it('insert into a region another replica concurrently deleted converges', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    const seed1 = a.localInsert(0, 'P');
    const seed2 = a.localInsert(1, 'Q');
    b.apply(seed1);
    b.apply(seed2);
    expect(a.toString()).toBe('PQ');
    expect(b.toString()).toBe('PQ');

    // A deletes 'Q'; concurrently B inserts 'R' right after the very item A is deleting.
    const del = a.localDelete(1);
    const ins = b.localInsert(2, 'R');
    expect(del).not.toBeNull();

    a.apply(ins);
    b.apply(del as NonNullable<typeof del>);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe('PR');
    // The deleted item is a tombstone, not spliced out — item count still includes it.
    expect(a.items).toHaveLength(3);
    expect(b.items).toHaveLength(3);
  });

  it('two replicas deleting the same character is idempotent and converges', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    const seed = a.localInsert(0, 'Z');
    b.apply(seed);

    const delA = a.localDelete(0);
    const delB = b.localDelete(0);
    expect(delA).not.toBeNull();
    expect(delB).not.toBeNull();

    a.apply(delB as NonNullable<typeof delB>);
    b.apply(delA as NonNullable<typeof delA>);

    expect(a.toString()).toBe('');
    expect(b.toString()).toBe('');
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    // Length asserted above: index 0 is guaranteed present.
    expect(a.items[0]!.deleted).toBe(true);
    expect(b.items[0]!.deleted).toBe(true);
  });

  it('applying the same operation twice is a no-op', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    const op = a.localInsert(0, 'k');

    expect(b.apply(op)).toBe(true);
    expect(b.apply(op)).toBe(false);
    expect(b.toString()).toBe('k');
    expect(b.items).toHaveLength(1);
  });

  it('tombstones persist — items.length never decreases across a delete', () => {
    const doc = new Doc('A');
    doc.localInsert(0, 'a');
    doc.localInsert(1, 'b');
    const before = doc.items.length;
    doc.localDelete(0);
    expect(doc.items.length).toBe(before);
    expect(doc.toString()).toBe('b');
  });
});

describe('Doc — SPEC §12 known limitation', () => {
  it('forward insertion runs stay contiguous', () => {
    const seed = new Doc('S');
    const x = seed.localInsert(0, 'X');
    const a = new Doc('A');
    const b = new Doc('B');
    a.apply(x);
    b.apply(x);

    const opsA = 'HELLO'.split('').map((ch, i) => a.localInsert(1 + i, ch));
    const opsB = 'WORLD'.split('').map((ch, i) => b.localInsert(1 + i, ch));
    opsB.forEach((op) => a.apply(op));
    opsA.forEach((op) => b.apply(op));

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toMatch(/^X(HELLOWORLD|WORLDHELLO)$/);
  });

  // Documenting known behavior per SPEC §12 — do not "fix" this. Any scan-rule
  // change that appears to fix it breaks convergence elsewhere (CLAUDE.md).
  it('documents_rga_backward_interleaving', () => {
    const seed = new Doc('S');
    const x = seed.localInsert(0, 'X');
    const a = new Doc('A');
    const b = new Doc('B');
    a.apply(x);
    b.apply(x);

    // Same origin every time — cursor held still, typing "before" it (e.g. Home + type).
    const opsA = 'HELLO'.split('').map((ch) => a.localInsert(1, ch));
    const opsB = 'WORLD'.split('').map((ch) => b.localInsert(1, ch));

    opsB.forEach((op) => a.apply(op));
    opsA.forEach((op) => b.apply(op));

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe('XDOLLRLOEWH');
  });
});

describe('Doc — agrees with the reference oracle', () => {
  it('produces identical output to rga-harness.mjs on the same operation sequence', () => {
    const seedOurs = new Doc('S');
    const seedOracle = new OracleDoc('S');
    const xOurs = seedOurs.localInsert(0, 'X');
    const xOracle = seedOracle.localInsert(0, 'X');

    const aOurs = new Doc('A');
    const bOurs = new Doc('B');
    const aOracle = new OracleDoc('A');
    const bOracle = new OracleDoc('B');
    aOurs.apply(xOurs);
    bOurs.apply(xOurs);
    aOracle.apply(xOracle);
    bOracle.apply(xOracle);

    const wordA = 'HELLO';
    const wordB = 'WORLD';
    const opsAOurs = wordA.split('').map((ch, i) => aOurs.localInsert(1 + i, ch));
    const opsBOurs = wordB.split('').map((ch, i) => bOurs.localInsert(1 + i, ch));
    const opsAOracle = wordA.split('').map((ch, i) => aOracle.localInsert(1 + i, ch));
    const opsBOracle = wordB.split('').map((ch, i) => bOracle.localInsert(1 + i, ch));

    opsBOurs.forEach((op) => aOurs.apply(op));
    opsAOurs.forEach((op) => bOurs.apply(op));
    opsBOracle.forEach((op) => aOracle.apply(op));
    opsAOracle.forEach((op) => bOracle.apply(op));

    expect(aOurs.toString()).toBe(aOracle.toString());
    expect(bOurs.toString()).toBe(bOracle.toString());
    expect(aOurs.items).toHaveLength(aOracle.items.length);
  });
});
