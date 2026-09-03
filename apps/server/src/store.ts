import type { Op } from '@idem/protocol';
import { asc, eq } from 'drizzle-orm';

import type { Database } from './db/client.js';
import { opLog } from './db/schema.js';

/** Durable op log, keyed by document. `Room` is the only caller. */
export interface OpStore {
  /** Every op for a document, in `seq` order — used to hydrate a room on first access. */
  load(docId: string): Promise<Op[]>;
  /** Appends a batch of already-seq-assigned ops. Safe to call with a batch a previous, crashed
   * attempt already partially wrote — the unique constraint on (doc_id, replica, lamport) is the backstop. */
  append(docId: string, entries: readonly { seq: number; op: Op }[]): Promise<void>;
}

export function createPostgresStore(db: Database): OpStore {
  return {
    async load(docId) {
      const rows = await db
        .select({ op: opLog.op })
        .from(opLog)
        .where(eq(opLog.docId, docId))
        .orderBy(asc(opLog.seq));
      return rows.map((row) => row.op);
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
  };
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
    load: (docId) => resolve().load(docId),
    append: (docId, entries) => resolve().append(docId, entries),
  };
}

/** In-memory `OpStore` for tests that exercise room/broadcast logic without a real database. */
export function createMemoryStore(): OpStore {
  const logs = new Map<string, Op[]>();
  return {
    async load(docId) {
      return [...(logs.get(docId) ?? [])];
    },
    async append(docId, entries) {
      const log = logs.get(docId) ?? [];
      logs.set(docId, log);
      for (const { op } of entries) log.push(op);
    },
  };
}
