/**
 * Idem — reference RGA harness
 *
 * A known-good, dependency-free implementation of the integration rule in
 * docs/SPEC.md §3, plus the fuzzer that validates it. Run it with:
 *
 *     node docs/reference/rga-harness.mjs
 *
 * Expected output:
 *     convergence: 1000/1000 trials converged
 *     forward runs stay contiguous       -> XWORLDHELLO
 *     backward runs interleave (SPEC §12) -> XDOLLRLOEWH
 *     commutativity: true | idempotency: true
 *
 * This file is NOT the project. It is the oracle. Port it to TypeScript in
 * packages/crdt, then port these checks to Vitest + fast-check (milestone M2).
 * If your implementation disagrees with this one, your implementation is wrong.
 */

// ---------------------------------------------------------------- identifiers

export function compareId(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0;
}

const idEq = (a, b) => a && b && a.lamport === b.lamport && a.replica === b.replica;
const key = (id) => `${id.replica}:${id.lamport}`;

// ---------------------------------------------------------------------- doc

export class Doc {
  constructor(replica) {
    this.replica = replica;
    this.clock = 0;
    this.items = [];       // includes tombstones, never shrinks
    this.applied = new Set();
  }

  indexOfItem(id) {
    for (let i = 0; i < this.items.length; i++) if (idEq(this.items[i].id, id)) return i;
    return -1;
  }

  visibleItems() { return this.items.filter((it) => !it.deleted); }
  toString() { return this.visibleItems().map((it) => it.content).join(''); }

  /** SPEC §3 — the correctness core. Do not alter without a property test. */
  integrateInsert(op) {
    let i = op.originLeft === null ? 0 : this.indexOfItem(op.originLeft) + 1;
    if (op.originLeft !== null && i === 0) throw new Error('causal delivery violated: missing originLeft');
    while (i < this.items.length && compareId(this.items[i].id, op.id) > 0) i++;
    this.items.splice(i, 0, {
      id: op.id, originLeft: op.originLeft, content: op.content, deleted: false,
    });
  }

  integrateDelete(op) {
    const idx = this.indexOfItem(op.target);
    if (idx === -1) throw new Error('causal delivery violated: missing delete target');
    this.items[idx].deleted = true;   // idempotent by construction
  }

  /** Returns false if the op was already applied (duplicate delivery). */
  apply(op) {
    if (this.applied.has(key(op.id))) return false;
    this.applied.add(key(op.id));
    this.clock = Math.max(this.clock, op.id.lamport);
    if (op.kind === 'insert') this.integrateInsert(op); else this.integrateDelete(op);
    return true;
  }

  localInsert(visibleIndex, ch) {
    const vis = this.visibleItems();
    const originLeft = visibleIndex === 0 ? null : vis[visibleIndex - 1].id;
    this.clock += 1;
    const op = {
      kind: 'insert',
      id: { lamport: this.clock, replica: this.replica },
      originLeft,
      content: ch,
    };
    this.applied.add(key(op.id));
    this.integrateInsert(op);
    return op;
  }

  localDelete(visibleIndex) {
    const vis = this.visibleItems();
    if (!vis.length) return null;
    const target = vis[Math.min(visibleIndex, vis.length - 1)].id;
    this.clock += 1;
    const op = { kind: 'delete', id: { lamport: this.clock, replica: this.replica }, target };
    this.applied.add(key(op.id));
    this.integrateDelete(op);
    return op;
  }
}

// ------------------------------------------------------------- sim network

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs `nReplicas` replicas over a seeded network with random delay, random
 * delivery order, and duplicate delivery — while preserving causal order.
 * Causal order is enforced by recording, for each op, the full set of ops its
 * author had applied at creation time, and refusing delivery until the
 * recipient has applied all of them.
 */
export function runTrial(seed, nReplicas, nRounds) {
  const rnd = mulberry32(seed);
  const replicas = Array.from({ length: nReplicas }, (_, i) => new Doc(String.fromCharCode(65 + i)));
  const log = [];
  const pending = replicas.map(() => []);

  const ready = (doc, deps) => {
    for (const d of deps) if (!doc.applied.has(d)) return false;
    return true;
  };

  for (let round = 0; round < nRounds; round++) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r];
      if (rnd() < 0.55) {
        const visCount = doc.visibleItems().length;
        const op = visCount > 0 && rnd() < 0.25
          ? doc.localDelete(Math.floor(rnd() * visCount))
          : doc.localInsert(Math.floor(rnd() * (visCount + 1)), String.fromCharCode(97 + Math.floor(rnd() * 26)));
        if (!op) continue;
        const deps = new Set(doc.applied); deps.delete(key(op.id));
        const idx = log.length;
        log.push({ op, deps });
        for (let o = 0; o < nReplicas; o++) if (o !== r) pending[o].push(idx);
      } else {
        const q = pending[r];
        const deliverable = q.map((v, j) => j).filter((j) => ready(doc, log[q[j]].deps));
        if (!deliverable.length) continue;
        const pick = deliverable[Math.floor(rnd() * deliverable.length)];
        const entry = log[q[pick]];
        q.splice(pick, 1);
        doc.apply(entry.op);
        if (rnd() < 0.15) doc.apply(entry.op);   // duplicate delivery must be a no-op
      }
    }
  }

  // drain
  let guard = 0;
  while (pending.some((q) => q.length) && guard++ < 100000) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r], q = pending[r];
      for (let j = 0; j < q.length; j++) {
        if (ready(doc, log[q[j]].deps)) { const e = log[q[j]]; q.splice(j, 1); doc.apply(e.op); break; }
      }
    }
  }

  const texts = replicas.map((d) => d.toString());
  return {
    converged: texts.every((t) => t === texts[0]) &&
               replicas.every((d) => d.items.length === replicas[0].items.length),
    texts,
  };
}

// ------------------------------------------------------------------- checks

if (import.meta.url === `file://${process.argv[1]}`) {
  let fails = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const res = runTrial(seed, 2 + (seed % 4), 40);
    if (!res.converged) { fails++; if (fails <= 3) console.log('DIVERGED at seed', seed, res.texts); }
  }
  console.log(`convergence: ${1000 - fails}/1000 trials converged`);

  // SPEC §12 — forward runs stay contiguous
  {
    const s = new Doc('S'), x = s.localInsert(0, 'X');
    const a = new Doc('A'), b = new Doc('B');
    a.apply(x); b.apply(x);
    const aOps = 'HELLO'.split('').map((c, i) => a.localInsert(1 + i, c));
    const bOps = 'WORLD'.split('').map((c, i) => b.localInsert(1 + i, c));
    bOps.forEach((o) => a.apply(o)); aOps.forEach((o) => b.apply(o));
    console.log(`forward runs stay contiguous        -> ${a.toString()}  (converged: ${a.toString() === b.toString()})`);
  }

  // SPEC §12 — backward runs interleave
  {
    const s = new Doc('S'), x = s.localInsert(0, 'X');
    const a = new Doc('A'), b = new Doc('B');
    a.apply(x); b.apply(x);
    const aOps = 'HELLO'.split('').map((c) => a.localInsert(1, c));   // same origin every time
    const bOps = 'WORLD'.split('').map((c) => b.localInsert(1, c));
    bOps.forEach((o) => a.apply(o)); aOps.forEach((o) => b.apply(o));
    console.log(`backward runs interleave (SPEC §12) -> ${a.toString()}  (converged: ${a.toString() === b.toString()})`);
  }

  // commutativity + idempotency
  {
    const c1 = new Doc('C'), c2 = new Doc('D');
    const o1 = c1.localInsert(0, 'a'), o2 = c2.localInsert(0, 'b');
    c1.apply(o2); c1.apply(o2); c2.apply(o1);
    console.log(`commutativity: ${c1.toString() === c2.toString()} | idempotency: ${c1.toString().length === 2}`);
  }
}
