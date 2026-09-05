import type { Item, Op, OpId } from '@idem/protocol';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';

import type { Database } from './db/client.js';
import { opLog, snapshot } from './db/schema.js';

/** A materialized document state as of `seq` — SPEC §9's `snapshot` row. */
export interface SnapshotRecord {
  readonly seq: number;
  readonly items: Item[];
}

/** One durably-stored op together with the `seq` the server assigned it. */
export interface SeqOp {
  readonly seq: number;
  readonly op: Op;
}

/** Durable op log and snapshots, keyed by document. `Room` is the only caller. */
export interface OpStore {
  /**
   * Every op id in the log, as `(replica, lamport)` only. Deliberately narrow:
   * this feeds the room's dedup set, which needs identity and nothing else, so
   * it must never pay to deserialize the `op` jsonb for the whole history.
   */
  opIds(docId: string): Promise<OpId[]>;
  /** Ops with `seq > sinceSeq`, in `seq` order — the catch-up tail. */
  loadSince(docId: string, sinceSeq: number): Promise<SeqOp[]>;
  /** Every op for a document, in `seq` order. Convenience over `loadSince(docId, 0)`. */
  load(docId: string): Promise<Op[]>;
  /** Appends a batch of already-seq-assigned ops. Safe to call with a batch a previous, crashed
   * attempt already partially wrote — the unique constraint on (doc_id, replica, lamport) is the backstop. */
  append(docId: string, entries: readonly SeqOp[]): Promise<void>;
  /** The newest snapshot, or null for a document that has never reached the snapshot interval. */
  latestSnapshot(docId: string): Promise<SnapshotRecord | null>;
  /** Writes a snapshot and prunes all but the two most recent (SPEC §9). */
  putSnapshot(docId: string, record: SnapshotRecord): Promise<void>;
}

/** SPEC §9: "keep the two most recent snapshots and delete older ones". */
const SNAPSHOTS_KEPT = 2;

export function createPostgresStore(db: Database): OpStore {
  const store: OpStore = {
    async opIds(docId) {
      return db
        .select({ replica: opLog.replica, lamport: opLog.lamport })
        .from(opLog)
        .where(eq(opLog.docId, docId));
    },
    async loadSince(docId, sinceSeq) {
      return db
        .select({ seq: opLog.seq, op: opLog.op })
        .from(opLog)
        .where(and(eq(opLog.docId, docId), gt(opLog.seq, sinceSeq)))
        .orderBy(asc(opLog.seq));
    },
    async load(docId) {
      return (await store.loadSince(docId, 0)).map((row) => row.op);
    },
    async append(docId, entries) {
      if (entries.length === 0) return;
      await db
        .insert(opLog)
        .values(
          entries.map(({ seq, op }) => ({
            docId,
            seq,
            replica: op.id.replica,
            lamport: op.id.lamport,
            op,
          })),
        )
        .onConflictDoNothing();
    },
    async latestSnapshot(docId) {
      const rows = await db
        .select({ seq: snapshot.seq, items: snapshot.items })
        .from(snapshot)
        .where(eq(snapshot.docId, docId))
        .orderBy(desc(snapshot.seq))
        .limit(1);
      return rows[0] ?? null;
    },
    async putSnapshot(docId, record) {
      await db
        .insert(snapshot)
        .values({ docId, seq: record.seq, items: record.items })
        .onConflictDoNothing();
      // Prune by finding the oldest seq worth keeping and deleting below it,
      // rather than deleting by id list — one predicate, and it stays correct
      // if another process wrote a snapshot between these two statements.
      const kept = await db
        .select({ seq: snapshot.seq })
        .from(snapshot)
        .where(eq(snapshot.docId, docId))
        .orderBy(desc(snapshot.seq))
        .limit(SNAPSHOTS_KEPT);
      const oldestKept = kept[kept.length - 1]?.seq;
      if (oldestKept === undefined) return;
      await db.delete(snapshot).where(and(eq(snapshot.docId, docId), lt(snapshot.seq, oldestKept)));
    },
  };
  return store;
}

/**
 * Wraps `createPostgresStore` so the database connection is only opened on
 * first actual use — not at server startup. Keeps `createServer()` safe to
 * call without `DATABASE_URL` set (e.g. `/health`-only tests) while
 * production code still gets a real store the moment a room is loaded.
 */
export function createLazyPostgresStore(getDb: () => Database): OpStore {
  let cached: OpStore | undefined;
  function resolve(): OpStore {
    return (cached ??= createPostgresStore(getDb()));
  }
  return {
    opIds: (docId) => resolve().opIds(docId),
    loadSince: (docId, sinceSeq) => resolve().loadSince(docId, sinceSeq),
    load: (docId) => resolve().load(docId),
    append: (docId, entries) => resolve().append(docId, entries),
    latestSnapshot: (docId) => resolve().latestSnapshot(docId),
    putSnapshot: (docId, record) => resolve().putSnapshot(docId, record),
  };
}

/** In-memory `OpStore` for tests that exercise room/broadcast logic without a real database. */
export function createMemoryStore(): OpStore {
  const logs = new Map<string, SeqOp[]>();
  const snapshots = new Map<string, SnapshotRecord[]>();
  const store: OpStore = {
    async opIds(docId) {
      return (logs.get(docId) ?? []).map(({ op }) => op.id);
    },
    async loadSince(docId, sinceSeq) {
      return (logs.get(docId) ?? []).filter((entry) => entry.seq > sinceSeq);
    },
    async load(docId) {
      return (await store.loadSince(docId, 0)).map((entry) => entry.op);
    },
    async append(docId, entries) {
      const log = logs.get(docId) ?? [];
      logs.set(docId, log);
      const seen = new Set(log.map(({ op }) => `${op.id.replica}:${op.id.lamport}`));
      for (const entry of entries) {
        // Mirrors the unique constraint on (doc_id, replica, lamport).
        if (seen.has(`${entry.op.id.replica}:${entry.op.id.lamport}`)) continue;
        log.push(entry);
      }
    },
    async latestSnapshot(docId) {
      const kept = snapshots.get(docId);
      return kept?.[kept.length - 1] ?? null;
    },
    async putSnapshot(docId, record) {
      const kept = snapshots.get(docId) ?? [];
      snapshots.set(docId, kept);
      kept.push(record);
      kept.sort((a, b) => a.seq - b.seq);
      while (kept.length > SNAPSHOTS_KEPT) kept.shift();
    },
  };
  return store;
}
