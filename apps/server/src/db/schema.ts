/**
 * Drizzle schema — documents, op_log and snapshots, per SPEC §9.
 *
 * op_log is append-only. Every operation is written inside the same transaction
 * that assigns its `seq`, and a unique constraint on (doc, replica, lamport)
 * enforces idempotency at the database level.
 *
 * Defined in M7 (IDE-12).
 */

export {};
