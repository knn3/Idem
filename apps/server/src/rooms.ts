import type { Op, OpId, WelcomeMessage } from '@idem/protocol';

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
 * appends, and rebroadcasts (SPEC §5, CLAUDE.md). No persistence yet
 * (M7/M8): `welcome` always serves the in-memory tail, never a snapshot.
 */
export class Room {
  readonly docId: string;
  private seq = 0;
  private readonly log: Op[] = [];
  private readonly seen = new Set<string>();
  private readonly clients = new Map<string, RoomClient>();

  constructor(docId: string) {
    this.docId = docId;
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
   * is exactly the ops with `seq > sinceSeq` — no snapshot mechanism exists yet,
   * so a fresh client (`sinceSeq: 0`) gets the whole log as the tail.
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
   * Assigns `seq` to genuinely new ops and appends them to the log.
   * Deduplicates on the op's own id — `(replica, lamport)` — per SPEC §5: a
   * client's own ops come back from the server and must be recognized as
   * already applied, and the reconnect path may resend an op the server
   * already has. Returns `null` when every op in the batch was a duplicate,
   * so the caller knows not to broadcast an empty no-op.
   */
  applyOps(ops: readonly Op[]): { seq: number; ops: Op[] } | null {
    const accepted: Op[] = [];
    for (const op of ops) {
      const key = opKey(op.id);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.seq += 1;
      this.log.push(op);
      accepted.push(op);
    }
    return accepted.length === 0 ? null : { seq: this.seq, ops: accepted };
  }

  /** Rebroadcasts to every connected client, including the sender (SPEC §6 step 4). */
  broadcast(raw: string): void {
    for (const client of this.clients.values()) client.send(raw);
  }
}

/** Rooms keyed by document id, created lazily on first `hello`. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  getOrCreate(docId: string): Room {
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Room(docId);
      this.rooms.set(docId, room);
    }
    return room;
  }
}
