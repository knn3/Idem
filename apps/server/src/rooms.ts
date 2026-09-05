import { Doc } from '@idem/crdt';
import type { Item, Op, OpId, WelcomeMessage } from '@idem/protocol';

import type { OpStore, SeqOp } from './store.js';

/**
 * A connected replica within a room. `send` is the transport hook — the ws
 * handler supplies it, so this module stays testable without real sockets.
 */
export interface RoomClient {
  readonly replica: string;
  readonly send: (raw: string) => void;
}

function opKey(id: OpId): string {
  return `${id.replica}:${id.lamport}`;
}

/** SPEC §9: snapshots are written every 500 operations. */
export const SNAPSHOT_INTERVAL = 500;

/**
 * The replica id the server materializes snapshots under. It is never used to
 * mint an `OpId` — the server authors no operations — but `Doc` requires one.
 */
const SNAPSHOT_REPLICA = 'server';

export interface RoomOptions {
  /** Overridable so tests can cross a snapshot boundary without 500 ops. */
  readonly snapshotInterval?: number;
}

/**
 * One document's live state: connected clients, the catch-up tail, the latest
 * snapshot, and the `seq` counter. The server never resolves conflicts here —
 * it only assigns `seq`, appends, and rebroadcasts (SPEC §5, CLAUDE.md).
 *
 * `seq` and the in-memory state are authoritative for a running process — the
 * store is a durability side-channel, not a gate. `applyOps` advances
 * in-memory state synchronously (so concurrent calls can never race on
 * `seq`, since nothing awaits between reading and incrementing it) and
 * fires the database writes without waiting on them: SPEC §9 permits "an
 * in-memory counter per loaded room with the unique constraint as the
 * backstop" instead of a database-transaction-per-op design. A process
 * crash between commit and a still-in-flight append loses at most that
 * batch — recovered by construction on the next restart, since `load`
 * rebuilds `seq` from whatever the store actually persisted.
 *
 * ### Snapshots (M8)
 *
 * Replaying a long log costs O(n) integrations of O(n) scan each, so a
 * 10,000-op document is quadratic to rebuild. Every `snapshotInterval` ops the
 * room materializes its items and stores them; `welcome` then serves a client
 * that is far behind the snapshot plus the short tail after it, instead of the
 * whole history, and `load` hydrates the same way.
 *
 * Materializing is **not** the server arbitrating. It runs the identical
 * deterministic function every client runs and keeps the result only as a load
 * accelerator: the op log stays the source of truth, and if materialization
 * ever throws (a client sent an op that violates causal delivery) the snapshot
 * is skipped and everything still works from the log.
 */
export class Room {
  readonly docId: string;
  private seq = 0;
  /** `seq` of the newest snapshot; 0 when the document has never reached the interval. */
  private snapshotSeq = 0;
  private snapshotItems: Item[] = [];
  /** Ops with `seq > snapshotSeq` — everything the snapshot does not already account for. */
  private readonly tail: SeqOp[] = [];
  private readonly seen = new Set<string>();
  private readonly clients = new Map<string, RoomClient>();
  private readonly store: OpStore;
  private readonly snapshotInterval: number;
  private pending: Promise<void> = Promise.resolve();

  private constructor(docId: string, store: OpStore, options: RoomOptions) {
    this.docId = docId;
    this.store = store;
    this.snapshotInterval = options.snapshotInterval ?? SNAPSHOT_INTERVAL;
  }

  /**
   * Hydrates a room from the newest snapshot plus the ops after it. The dedup
   * set is rebuilt from every op id in the log, not just the tail's: a snapshot
   * records that an item is a tombstone but not the id of the delete op that
   * made it one, so the ids have to come from the log to keep dedup exact.
   * That read is deliberately narrow — `(replica, lamport)` only, never the
   * `op` payload — so it stays cheap at any history length.
   */
  static async load(docId: string, store: OpStore, options: RoomOptions = {}): Promise<Room> {
    const room = new Room(docId, store, options);
    const snapshot = await store.latestSnapshot(docId);
    const [ids, tail] = await Promise.all([
      store.opIds(docId),
      store.loadSince(docId, snapshot?.seq ?? 0),
    ]);

    if (snapshot) {
      room.snapshotSeq = snapshot.seq;
      room.snapshotItems = snapshot.items;
    }
    for (const id of ids) room.seen.add(opKey(id));
    room.tail.push(...tail);
    room.seq = tail[tail.length - 1]?.seq ?? room.snapshotSeq;
    return room;
  }

  join(client: RoomClient): void {
    this.clients.set(client.replica, client);
  }

  leave(replica: string): void {
    this.clients.delete(replica);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Response to `hello`, per SPEC §6's connect/reconnect sequence.
   *
   * A client at or past the snapshot only needs the ops it is missing, so it
   * gets the tail sliced at `sinceSeq` and no snapshot. A client behind the
   * snapshot — including every first-time client, at `sinceSeq: 0` — gets the
   * snapshot plus the whole tail, which is bounded by `snapshotInterval`
   * however long the document's history is.
   */
  welcome(sinceSeq: number): WelcomeMessage {
    if (sinceSeq < this.snapshotSeq) {
      return {
        t: 'welcome',
        snapshot: { seq: this.snapshotSeq, items: this.snapshotItems },
        ops: this.tail.map((entry) => entry.op),
        seq: this.seq,
      };
    }
    return {
      t: 'welcome',
      snapshot: null,
      ops: this.tail.filter((entry) => entry.seq > sinceSeq).map((entry) => entry.op),
      seq: this.seq,
    };
  }

  /**
   * Assigns `seq` to genuinely new ops, appends them to the tail, and starts
   * (without awaiting) their durable write. Deduplicates on the op's own id —
   * `(replica, lamport)` — per SPEC §5: a client's own ops come back from the
   * server and must be recognized as already applied, and the reconnect path
   * may resend an op the server already has. Returns `null` when every op in
   * the batch was a duplicate, so the caller knows not to broadcast an empty
   * no-op.
   */
  applyOps(ops: readonly Op[]): { seq: number; ops: Op[] } | null {
    const accepted: Op[] = [];
    const toPersist: SeqOp[] = [];
    for (const op of ops) {
      const key = opKey(op.id);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.seq += 1;
      this.tail.push({ seq: this.seq, op });
      accepted.push(op);
      toPersist.push({ seq: this.seq, op });
    }
    if (accepted.length === 0) return null;
    this.enqueue(() => this.store.append(this.docId, toPersist), 'op_log append');
    this.maybeSnapshot();
    return { seq: this.seq, ops: accepted };
  }

  /**
   * Materializes and stores a snapshot once the tail has grown past the
   * interval, then truncates the tail. The boundary is checked once per
   * `applyOps` batch rather than once per op, so a batch that overshoots the
   * interval takes one snapshot at its end instead of several — SPEC §9's
   * "every 500 operations" is a bound on tail length, not an exact cadence.
   *
   * Runs synchronously up to the database
   * write: it is at most `snapshotInterval` integrations, and doing it inline
   * means no await sits between reading and truncating `tail`, so a concurrent
   * `applyOps` can never lose an op to the truncation.
   */
  private maybeSnapshot(): void {
    if (this.seq - this.snapshotSeq < this.snapshotInterval) return;

    let items: Item[];
    try {
      const doc = Doc.fromItems(SNAPSHOT_REPLICA, this.snapshotItems);
      for (const { op } of this.tail) doc.apply(op);
      items = doc.items;
    } catch (err: unknown) {
      // A snapshot is an optimization, never a gate. If a client sent an op
      // that violates causal delivery, keep relaying from the log and try
      // again at the next boundary rather than taking the room down.
      console.error(`snapshot materialization failed for doc ${this.docId}:`, err);
      return;
    }

    const record = { seq: this.seq, items };
    this.snapshotSeq = record.seq;
    this.snapshotItems = record.items;
    this.tail.length = 0;
    this.enqueue(() => this.store.putSnapshot(this.docId, record), 'snapshot write');
  }

  /** Serializes durable writes behind one chain so `flush` covers all of them and they land in order. */
  private enqueue(write: () => Promise<void>, what: string): void {
    this.pending = this.pending.then(write).catch((err: unknown) => {
      console.error(`${what} failed for doc ${this.docId}:`, err);
    });
  }

  /** Awaits every write started so far. Not used on the live broadcast path — only by tests and graceful shutdown that need to know a write actually landed. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Rebroadcasts to every connected client, including the sender (SPEC §6 step 4). */
  broadcast(raw: string): void {
    for (const client of this.clients.values()) client.send(raw);
  }
}

/** Rooms keyed by document id, hydrated from the store lazily on first `hello`. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly store: OpStore;
  private readonly options: RoomOptions;

  constructor(store: OpStore, options: RoomOptions = {}) {
    this.store = store;
    this.options = options;
  }

  getOrCreate(docId: string): Promise<Room> {
    let room = this.rooms.get(docId);
    if (!room) {
      room = Room.load(docId, this.store, this.options);
      this.rooms.set(docId, room);
    }
    return room;
  }
}
