import type { Op, OpId } from '@idem/crdt';
import { opSchema } from '@idem/protocol';

/**
 * The outbox: operations this client has created but not yet seen acknowledged
 * by the server (SPEC §7).
 *
 * It is persisted so a page reload — or a browser crash — while offline does
 * not lose an edit the user already saw appear on their screen. Order is
 * preserved and load-bearing: an operation's `originLeft` may be an item
 * created by an earlier operation in the same queue, so replaying the outbox
 * out of order would violate causal delivery.
 *
 * Removal is by operation id rather than "drain the whole queue", because
 * new local edits keep arriving while an earlier batch is in flight.
 */
export interface Outbox {
  /** Every unacknowledged operation, in creation order. */
  all(): Promise<Op[]>;
  add(ops: readonly Op[]): Promise<void>;
  ack(ids: readonly OpId[]): Promise<void>;
}

/** The `(replica, lamport)` identity an operation is deduplicated on, SPEC §5. */
export function opKey(id: OpId): string {
  return `${id.replica}:${id.lamport}`;
}

/** Non-persistent outbox. Used by tests, and as the fallback when IndexedDB is unavailable. */
export function createMemoryOutbox(): Outbox {
  const entries = new Map<string, Op>();
  return {
    all() {
      // Map iteration is insertion-ordered, which is the creation order the
      // replay path depends on.
      return Promise.resolve([...entries.values()]);
    },
    add(ops) {
      for (const op of ops) entries.set(opKey(op.id), op);
      return Promise.resolve();
    },
    ack(ids) {
      for (const id of ids) entries.delete(opKey(id));
      return Promise.resolve();
    },
  };
}

const DB_NAME = 'idem-outbox';
const DB_VERSION = 1;
const STORE = 'ops';

interface OutboxRecord {
  readonly docId: string;
  readonly key: string;
  readonly op: Op;
}

/** Validates one stored row back into an `Op`, or null if it is not one. */
function readRecord(value: unknown): Op | null {
  if (typeof value !== 'object' || value === null || !('op' in value)) return null;
  const parsed = opSchema.safeParse(value.op);
  return parsed.success ? parsed.data : null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('E_IDB_REQUEST: IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // autoIncrement, so the primary key is monotonic in insertion order and
      // `getAll` over the docId index comes back in creation order.
      const store = req.result.createObjectStore(STORE, { autoIncrement: true });
      store.createIndex('docId', 'docId', { unique: false });
      store.createIndex('key', 'key', { unique: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('E_IDB_OPEN: could not open the outbox'));
    req.onblocked = () =>
      reject(new Error('E_IDB_BLOCKED: another tab is holding an old outbox version open'));
  });
}

/**
 * Outbox backed by IndexedDB, scoped to one document.
 *
 * Scoped by `docId` rather than by replica: a reload mints a new replica id,
 * but the operations queued under the old one are still valid operations that
 * the server has never seen, and dropping them is exactly the data loss this
 * queue exists to prevent.
 */
export function createIndexedDbOutbox(docId: string, db: IDBDatabase): Outbox {
  function tx(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  return {
    async all() {
      const records = await request<unknown[]>(tx('readonly').index('docId').getAll(docId));
      const ops: Op[] = [];
      for (const record of records) {
        const op = readRecord(record);
        // A record written by an older build of the app is data from a
        // boundary like any other, so it is validated rather than trusted
        // (CLAUDE.md hard rule 9). One unreadable row must not wedge the
        // queue behind it.
        if (op) ops.push(op);
        else console.warn('[idem] discarding an unreadable outbox record', record);
      }
      return ops;
    },
    async add(ops) {
      if (ops.length === 0) return;
      const store = tx('readwrite');
      await Promise.all(
        ops.map(async (op) => {
          const record: OutboxRecord = { docId, key: `${docId}|${opKey(op.id)}`, op };
          try {
            await request(store.add(record));
          } catch {
            // The unique index rejected it: this operation is already queued.
            // Re-queuing the same operation is meaningless, not an error.
          }
        }),
      );
    },
    async ack(ids) {
      if (ids.length === 0) return;
      const store = tx('readwrite');
      const index = store.index('key');
      await Promise.all(
        ids.map(async (id) => {
          const primaryKey = await request(index.getKey(`${docId}|${opKey(id)}`));
          if (primaryKey !== undefined) await request(store.delete(primaryKey));
        }),
      );
    },
  };
}

/**
 * The outbox a browser client should use: IndexedDB when it is available,
 * memory when it is not (private windows, storage disabled by policy).
 *
 * Falling back rather than failing is deliberate — an in-memory outbox still
 * gives you the whole offline-edit-and-reconnect path, and only loses the
 * narrower guarantee that a reload while offline keeps your edits.
 */
export async function createOutbox(docId: string): Promise<Outbox> {
  if (typeof indexedDB === 'undefined') return createMemoryOutbox();
  try {
    return createIndexedDbOutbox(docId, await openDatabase());
  } catch (err) {
    console.warn('[idem] IndexedDB unavailable; offline edits will not survive a reload', err);
    return createMemoryOutbox();
  }
}
