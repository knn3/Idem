import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runFuzz, runTrial } from './sim-network.js';

// M2 (IDE-7): fast-check generators plus the seeded SimNetwork harness,
// ported from `runTrial` in docs/reference/rga-harness.mjs.
//
// Acceptance: 1,000 generated cases converge across 2–5 replicas with duplicate
// delivery enabled, and a seeded 10,000-operation fuzz run with partitions ends
// with all replicas byte-identical. This suite is the most valuable artifact
// in the repo (CLAUDE.md, PLAN.md M2).
describe('convergence', () => {
  it('converges across 2–5 replicas under delay, reordering and duplication', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 5 }),
        (seed, nReplicas) => {
          const result = runTrial(seed, nReplicas, 40);
          expect(result.converged).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('converges after a partition heals (seeded, 10,000 operations)', () => {
    const result = runFuzz(424242, {
      nReplicas: 4,
      nOps: 10_000,
      partitionChance: 0.01,
      partitionDuration: [50, 200],
    });
    expect(result.texts[0]).toBe(result.texts[1]);
    expect(result.texts[0]).toBe(result.texts[2]);
    expect(result.texts[0]).toBe(result.texts[3]);
    expect(result.converged).toBe(true);
  });
});
