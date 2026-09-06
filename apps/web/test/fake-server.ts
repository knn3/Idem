import { Doc, type Item, type Op, type OpId } from '@idem/crdt';
import { parseClientMessage, serializeMessage } from '@idem/protocol';

import type { Connect, SocketHandlers, SyncSocket } from '../app/sync/sync-client';

/**
 * A stand-in for `apps/server`'s `Room`, small enough to read in one sitting:
 * assign `seq`, deduplicate on `(replica, lamport)`, append, rebroadcast to
 * everyone including the sender. It arbitrates nothing, exactly like the real
 * server (SPEC §5).
 *
 * It exists so the offline path can be tested without a socket, a database, or
 * a browser. The real server is covered by `apps/server/test`, and the whole
 * stack together by `e2e/offline.spec.ts` — this fake only has to be a faithful
 * peer for the client's queue-and-resend logic.
 *
 * Every callback fires asynchronously, like a real `WebSocket`: a socket whose
 * `open` arrives before the constructor returns is a shape no browser produces,
 * and tests that assume it would hide bugs rather than find them.
 */
export interface FakeNetwork {
  readonly connect: Connect;
  /** Cuts the network: every open socket closes and new connections fail until this is called with true. */
  setOnline(online: boolean): void;
  /** Materializes a snapshot and truncates the tail, as `Room.maybeSnapshot` does at its interval. */
  takeSnapshot(): void;
  /** Every operation the server has accepted, in `seq` order. */
  readonly log: readonly Op[];
  /** The server's own view of the text — what every converged client must agree with. */
  text(): string;
}

function opKey(id: OpId): string {
  return `${id.replica}:${id.lamport}`;
}

interface Connection {
  readonly handlers: SocketHandlers;
  open: boolean;
}

export function createFakeNetwork(): FakeNetwork {
  const connections = new Set<Connection>();
  const seen = new Set<string>();
  const accepted: Op[] = [];
  let tail: { seq: number; op: Op }[] = [];
  let snapshotSeq = 0;
  let snapshotItems: Item[] = [];
  let seq = 0;
  let online = true;

  function materialize(from: Item[], ops: readonly Op[]): Doc {
    const doc = Doc.fromItems('fake-server', from);
    for (const op of ops) doc.apply(op);
    return doc;
  }

  function broadcast(raw: string): void {
    for (const connection of connections) {
      // Rechecked on delivery, not on send: a socket that dies between the two
      // is exactly how an acknowledgement gets lost, and losing one has to be
      // reachable for the reconnect path to be tested at all.
      queueMicrotask(() => {
        if (connection.open) connection.handlers.onMessage(raw);
      });
    }
  }

  function receive(connection: Connection, raw: string): void {
    const message = parseClientMessage(raw);
    if (message.t === 'hello') {
      const behindSnapshot = message.sinceSeq < snapshotSeq;
      const welcome = serializeMessage({
        t: 'welcome',
        snapshot: behindSnapshot ? { seq: snapshotSeq, items: snapshotItems } : null,
        ops: tail
          .filter((entry) => behindSnapshot || entry.seq > message.sinceSeq)
          .map((e) => e.op),
        seq,
      });
      queueMicrotask(() => {
        if (connection.open) connection.handlers.onMessage(welcome);
      });
      return;
    }
    if (message.t !== 'ops') return;

    const fresh: Op[] = [];
    for (const op of message.ops) {
      const key = opKey(op.id);
      if (seen.has(key)) continue; // SPEC §5: at-least-once delivery, deduplicated here
      seen.add(key);
      seq += 1;
      tail.push({ seq, op });
      accepted.push(op);
      fresh.push(op);
    }
    if (fresh.length === 0) return;
    broadcast(serializeMessage({ t: 'ops', ops: fresh, seq }));
  }

  function closeAll(): void {
    for (const connection of connections) {
      if (!connection.open) continue;
      connection.open = false;
      queueMicrotask(() => connection.handlers.onClose());
    }
    connections.clear();
  }

  const connect: Connect = (_url, handlers): SyncSocket => {
    const connection: Connection = { handlers, open: online };
    if (!online) {
      queueMicrotask(() => handlers.onClose());
      return { send: () => {}, close: () => {} };
    }
    connections.add(connection);
    queueMicrotask(() => {
      if (connection.open) handlers.onOpen();
    });
    return {
      send: (raw) => {
        if (connection.open) receive(connection, raw);
      },
      close: () => {
        connection.open = false;
        connections.delete(connection);
      },
    };
  };

  return {
    connect,
    setOnline(next) {
      online = next;
      if (!next) closeAll();
    },
    takeSnapshot() {
      const doc = materialize(
        snapshotItems,
        tail.map((entry) => entry.op),
      );
      snapshotItems = doc.items;
      snapshotSeq = seq;
      tail = [];
    },
    get log() {
      return accepted;
    },
    text() {
      return materialize(
        snapshotItems,
        tail.map((entry) => entry.op),
      ).toString();
    },
  };
}

/** Lets every queued microtask — the fake network's whole delivery mechanism — run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
