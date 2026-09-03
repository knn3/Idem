import type { Op, OpId, WelcomeMessage } from '@idem/protocol';

import type { OpStore } from './store.js';

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

/**
 * One document's live state: connected clients, the op log, and the `seq`
 * counter. The server never resolves conflicts here — it only assigns `seq`,
 * appends, and rebroadcasts (SPEC §5, CLAUDE.md).
 *
 * `seq` and the in-memory log are authoritative for a running process — the
 * store is a durability side-channel, not a gate. `applyOps` advances
 * in-memory state synchronously (so concurrent calls can never race on
 * `seq`, since nothing awaits between reading and incrementing it) and
 * fires the database append without waiting on it: SPEC §9 permits "an
 * in-memory counter per loaded room with the unique constraint as the
 * backstop" instead of a database-transaction-per-op design. A process
 * crash between commit and a still-in-flight append loses at most that
 * batch — recovered by construction on the next restart, since `load`
 * rebuilds `seq` from whatever the store actually persisted.
 */
export class Room {
  readonly docId: string;
  private seq = 0;
  private readonly log: Op[] = [];
  private readonly seen = new Set<string>();
  private readonly clients = new Map<string, RoomClient>();
  private readonly store: OpStore;
  private pending: Promise<void> = Promise.resolve();

  private constructor(docId: string, store: OpStore) {
    this.docId = docId;
    this.store = store;
  }

  /** Hydrates a room from every op the store has for `docId` — empty for a brand-new document. */
  static async load(docId: string, store: OpStore): Promise<Room> {
    const room = new Room(docId, store);
    for (const op of await store.load(docId)) {
      room.seq += 1;
      room.log.push(op);
      room.seen.add(opKey(op.id));
    }
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
   * Response to `hello`. `log[i]` was assigned seq `i + 1`, so `log.slice(sinceSeq)`
   * is exactly the ops with `seq > sinceSeq`. No snapshot mechanism exists yet
   * (M8), so a fresh client (`sinceSeq: 0`) gets the whole log as the tail.
   */
  welcome(sinceSeq: number): WelcomeMessage {
    return {
      t: 'welcome',
      snapshot: null,
      ops: sinceSeq >= this.seq ? [] : this.log.slice(sinceSeq),
      seq: this.seq,
    };
  }

  /**
   * Assigns `seq` to genuinely new ops, appends them to the in-memory log,
   * and starts (without awaiting) their durable write. Deduplicates on the
   * op's own id — `(replica, lamport)` — per SPEC §5: a client's own ops
   * come back from the server and must be recognized as already applied,
   * and the reconnect path may resend an op the server already has.
   * Returns `null` when every op in the batch was a duplicate, so the
   * caller knows not to broadcast an empty no-op.
   */
  applyOps(ops: readonly Op[]): { seq: number; ops: Op[] } | null {
    const accepted: Op[] = [];
    const toPersist: { seq: number; op: Op }[] = [];
    for (const op of ops) {
      const key = opKey(op.id);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.seq += 1;
      this.log.push(op);
      accepted.push(op);
      toPersist.push({ seq: this.seq, op });
    }
    if (accepted.length === 0) return null;
    this.pending = this.store.append(this.docId, toPersist).catch((err: unknown) => {
      console.error(`op_log append failed for doc ${this.docId}:`, err);
    });
    return { seq: this.seq, ops: accepted };
  }

  /** Awaits every append started so far. Not used on the live broadcast path — only by tests and graceful shutdown that need to know a write actually landed. */
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

  constructor(store: OpStore) {
    this.store = store;
  }

  getOrCreate(docId: string): Promise<Room> {
    let room = this.rooms.get(docId);
    if (!room) {
      room = Room.load(docId, this.store);
      this.rooms.set(docId, room);
    }
    return room;
  }
}
