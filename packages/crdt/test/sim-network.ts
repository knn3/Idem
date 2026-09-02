import { Doc, type Op } from '../src/doc.js';
import { idKey } from '../src/id.js';

/**
 * Deterministic PRNG (mulberry32) so a fuzz run is replayable from its seed
 * alone — ported from docs/reference/rga-harness.mjs.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LogEntry {
  readonly op: Op;
  /** Every op-key the author had applied when this op was created — the causal dependency set. */
  readonly deps: ReadonlySet<string>;
}

export interface TrialResult {
  readonly converged: boolean;
  readonly texts: readonly string[];
}

/**
 * Runs `nReplicas` in-process replicas over a seeded network with random
 * delay, random delivery order, and duplicate delivery, while preserving
 * causal order: an op is only deliverable to a replica once every op its
 * author had applied at creation time has been applied there too (SPEC §5's
 * causal-order requirement, enforced explicitly here instead of by server
 * `seq`). Ported from `runTrial` in docs/reference/rga-harness.mjs.
 */
export function runTrial(seed: number, nReplicas: number, nRounds: number): TrialResult {
  const rnd = mulberry32(seed);
  const replicas = Array.from(
    { length: nReplicas },
    (_, i) => new Doc(String.fromCharCode(65 + i)),
  );
  const log: LogEntry[] = [];
  const pending: number[][] = replicas.map(() => []);

  const ready = (doc: Doc, deps: ReadonlySet<string>): boolean => {
    for (const d of deps) {
      // Doc doesn't expose `applied` directly; toString-based membership isn't
      // available, so we track delivery via the doc's own idempotent `apply`
      // and a mirrored applied-set here instead. See appliedKeys below.
      if (!appliedKeys.get(doc)?.has(d)) return false;
    }
    return true;
  };

  const appliedKeys = new Map<Doc, Set<string>>(replicas.map((d) => [d, new Set<string>()]));
  const applyTracked = (doc: Doc, op: Op): boolean => {
    const applied = doc.apply(op);
    appliedKeys.get(doc)!.add(idKey(op.id));
    return applied;
  };

  for (let round = 0; round < nRounds; round++) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r]!;
      if (rnd() < 0.55) {
        const visCount = doc.visibleItems().length;
        const op: Op | null =
          visCount > 0 && rnd() < 0.25
            ? doc.localDelete(Math.floor(rnd() * visCount))
            : doc.localInsert(
                Math.floor(rnd() * (visCount + 1)),
                String.fromCharCode(97 + Math.floor(rnd() * 26)),
              );
        if (!op) continue;
        appliedKeys.get(doc)!.add(idKey(op.id));
        const deps = new Set(appliedKeys.get(doc)!);
        deps.delete(idKey(op.id));
        const idx = log.length;
        log.push({ op, deps });
        for (let o = 0; o < nReplicas; o++) if (o !== r) pending[o]!.push(idx);
      } else {
        const q = pending[r]!;
        const deliverable = q.map((_, j) => j).filter((j) => ready(doc, log[q[j]!]!.deps));
        if (!deliverable.length) continue;
        const pick = deliverable[Math.floor(rnd() * deliverable.length)]!;
        const entry = log[q[pick]!]!;
        q.splice(pick, 1);
        applyTracked(doc, entry.op);
        if (rnd() < 0.15) applyTracked(doc, entry.op); // duplicate delivery must be a no-op
      }
    }
  }

  // Drain whatever is left in every pending queue, in causal order.
  let guard = 0;
  while (pending.some((q) => q.length) && guard++ < 200_000) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r]!;
      const q = pending[r]!;
      for (let j = 0; j < q.length; j++) {
        if (ready(doc, log[q[j]!]!.deps)) {
          const entry = log[q[j]!]!;
          q.splice(j, 1);
          applyTracked(doc, entry.op);
          break;
        }
      }
    }
  }

  const texts = replicas.map((d) => d.toString());
  return {
    converged:
      texts.every((t) => t === texts[0]) &&
      replicas.every((d) => d.items.length === replicas[0]!.items.length),
    texts,
  };
}

export interface FuzzOptions {
  readonly nReplicas: number;
  readonly nOps: number;
  /** Probability per tick a currently-unpartitioned replica gets cut off from delivery. */
  readonly partitionChance?: number;
  /** How many ticks a partition lasts, in [min, max]. */
  readonly partitionDuration?: readonly [number, number];
}

/**
 * Like `runTrial`, but paced by total operation count rather than rounds, and
 * with partitions: a replica can be cut off from delivery (while it keeps
 * producing and receiving local ops, and others keep queueing ops for it) for
 * a stretch of ticks, then heals and drains its backlog. Used for the single
 * large seeded fuzz run (PLAN.md M2), not the fast-check property (which
 * mirrors the oracle's `runTrial` exactly).
 */
export function runFuzz(seed: number, opts: FuzzOptions): TrialResult {
  const rnd = mulberry32(seed);
  const { nReplicas, nOps } = opts;
  const partitionChance = opts.partitionChance ?? 0.01;
  const [durMin, durMax] = opts.partitionDuration ?? [50, 200];

  const replicas = Array.from(
    { length: nReplicas },
    (_, i) => new Doc(String.fromCharCode(65 + i)),
  );
  const appliedKeys = new Map<Doc, Set<string>>(replicas.map((d) => [d, new Set<string>()]));
  const log: LogEntry[] = [];
  const pending: number[][] = replicas.map(() => []);
  const partitionedUntil: number[] = replicas.map(() => -1);

  const ready = (doc: Doc, deps: ReadonlySet<string>): boolean => {
    for (const d of deps) if (!appliedKeys.get(doc)!.has(d)) return false;
    return true;
  };
  const applyTracked = (doc: Doc, op: Op): boolean => {
    const applied = doc.apply(op);
    appliedKeys.get(doc)!.add(idKey(op.id));
    return applied;
  };

  let opsGenerated = 0;
  let tick = 0;
  while (opsGenerated < nOps) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r]!;
      const partitioned = tick < partitionedUntil[r]!;

      if (!partitioned && rnd() < partitionChance) {
        partitionedUntil[r] = tick + durMin + Math.floor(rnd() * (durMax - durMin + 1));
      }

      if (rnd() < 0.6) {
        const visCount = doc.visibleItems().length;
        const op: Op | null =
          visCount > 0 && rnd() < 0.25
            ? doc.localDelete(Math.floor(rnd() * visCount))
            : doc.localInsert(
                Math.floor(rnd() * (visCount + 1)),
                String.fromCharCode(97 + Math.floor(rnd() * 26)),
              );
        if (!op) continue;
        opsGenerated++;
        appliedKeys.get(doc)!.add(idKey(op.id));
        const deps = new Set(appliedKeys.get(doc)!);
        deps.delete(idKey(op.id));
        const idx = log.length;
        log.push({ op, deps });
        for (let o = 0; o < nReplicas; o++) if (o !== r) pending[o]!.push(idx);
      } else if (!partitioned) {
        const q = pending[r]!;
        const deliverable = q.map((_, j) => j).filter((j) => ready(doc, log[q[j]!]!.deps));
        if (!deliverable.length) continue;
        const pick = deliverable[Math.floor(rnd() * deliverable.length)]!;
        const entry = log[q[pick]!]!;
        q.splice(pick, 1);
        applyTracked(doc, entry.op);
        if (rnd() < 0.1) applyTracked(doc, entry.op); // duplicate delivery must be a no-op
      }
    }
    tick++;
  }

  let guard = 0;
  while (pending.some((q) => q.length) && guard++ < nOps * 20 + 10_000) {
    for (let r = 0; r < nReplicas; r++) {
      const doc = replicas[r]!;
      const q = pending[r]!;
      for (let j = 0; j < q.length; j++) {
        if (ready(doc, log[q[j]!]!.deps)) {
          const entry = log[q[j]!]!;
          q.splice(j, 1);
          applyTracked(doc, entry.op);
          break;
        }
      }
    }
  }

  const texts = replicas.map((d) => d.toString());
  return {
    converged:
      texts.every((t) => t === texts[0]) &&
      replicas.every((d) => d.items.length === replicas[0]!.items.length),
    texts,
  };
}
