/**
 * @idem/crdt — the Replicated Growable Array.
 *
 * This package imports nothing and performs no I/O. That constraint is
 * load-bearing: it is what makes the in-process multi-replica fuzzer possible,
 * and that fuzzer is the project's main evidence of correctness.
 * See CLAUDE.md hard rule 1 and SPEC §10.
 *
 * The algorithm is specified in docs/SPEC.md §1–§3 and there is a working
 * oracle at docs/reference/rga-harness.mjs. Port it; do not reinvent it.
 *
 * Implemented in M1 (IDE-6): OpId, compareId, Lamport clock rules, Item, Doc.
 */

export {};
