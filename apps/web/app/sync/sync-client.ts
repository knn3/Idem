import { Doc, type Item, type Op, type OpId } from '@idem/crdt';
import {
  parseServerMessage,
  serializeMessage,
  type Peer,
  type ServerMessage,
  type Snapshot,
} from '@idem/protocol';

import { opKey, type Outbox } from './outbox';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';

export interface SyncState {
  readonly status: ConnectionStatus;
  /** Operations created but not yet acknowledged by the server. */
  readonly pending: number;
  /** Set when `status` is 'error': what went wrong, in words a user can act on. */
  readonly error?: string;
}

/** The transport, narrowed to what this client uses, so tests can supply their own. */
export interface SyncSocket {
  send(raw: string): void;
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(raw: string): void;
  /** Called once when the socket ends, however it ended. Errors arrive here too. */
  onClose(): void;
}

export type Connect = (url: string, handlers: SocketHandlers) => SyncSocket;

/** Reconnect delays in milliseconds, the last one repeating. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

export interface SyncClientOptions {
  readonly url: string;
  readonly docId: string;
  readonly replica: string;
  readonly outbox: Outbox;
  /** Fired whenever the document text may have changed. */
  readonly onChange: () => void;
  readonly onState: (state: SyncState) => void;
  /** Fired with the roster, this replica already removed. Empty while offline. */
  readonly onPeers?: (peers: readonly Peer[]) => void;
  readonly connect?: Connect;
  readonly backoffMs?: readonly number[];
  readonly setTimer?: (fn: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

function browserConnect(url: string, handlers: SocketHandlers): SyncSocket {
  const ws = new WebSocket(url);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    handlers.onClose();
  };
  ws.addEventListener('open', () => handlers.onOpen());
  ws.addEventListener('message', (event: MessageEvent<string>) => handlers.onMessage(event.data));
  // A failed connect fires 'error' then 'close'; a dropped one fires 'close'
  // alone. Both mean the same thing here, and `end` collapses them to one call.
  ws.addEventListener('error', end);
  ws.addEventListener('close', end);
  return {
    send: (raw) => ws.send(raw),
    close: () => {
      ended = true; // a close we asked for must not trigger a reconnect
      ws.close();
    },
  };
}

/**
 * Owns the document, the socket, and the offline queue (M9, SPEC §6–§7).
 *
 * The contract with the editor is small on purpose: the editor mutates
 * `client.doc` with local edits and hands the resulting operations to `push`;
 * everything else — connecting, reconnecting, queuing, resending,
 * acknowledging — happens here, which is what makes the offline path testable
 * without a browser.
 *
 * **At-least-once delivery is the design.** The whole outbox is resent on every
 * reconnect without tracking what the server already has, because resending is
 * safe: `Doc.apply` is a no-op for an operation id it has already seen
 * (CLAUDE.md hard rule 5) and the server deduplicates on `(replica, lamport)`
 * (SPEC §5). Trying to be exactly-once here would add a failure mode and buy
 * nothing.
 *
 * `doc` is replaced wholesale when the server sends a snapshot, so callers must
 * read the getter every time rather than caching the reference.
 */
export class SyncClient {
  private readonly options: SyncClientOptions;
  private readonly connect: Connect;
  private readonly backoff: readonly number[];
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private currentDoc: Doc;
  private socket: SyncSocket | null = null;
  private status: ConnectionStatus = 'offline';
  private error: string | null = null;
  private retries = 0;
  private timer: number | null = null;
  private destroyed = false;

  /** In-memory mirror of the outbox, in creation order. The stored copy is the durable one. */
  private pending: Op[] = [];
  /** Serializes outbox writes so an acknowledgement can never overtake the add it removes. */
  private writes: Promise<void> = Promise.resolve();
  /** Highest `seq` applied — sent as `sinceSeq` so a reconnect asks only for what it missed. */
  private sinceSeq = 0;
  /** When the current connection's `hello` went out, for the M8 load-time report. */
  private helloSentAt = 0;
  /** Last presence sent, so an unchanged cursor does not put a message on the wire. */
  private sentPresence = '';

  constructor(options: SyncClientOptions) {
    this.options = options;
    this.connect = options.connect ?? browserConnect;
    this.backoff = options.backoffMs ?? BACKOFF_MS;
    // `window`, not the bare global: this is a browser client, and Node's
    // `setTimeout` hands back a Timeout object rather than a handle. Tests
    // supply their own timers and never reach these.
    this.setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
    this.currentDoc = new Doc(options.replica);
  }

  get doc(): Doc {
    return this.currentDoc;
  }

  get state(): SyncState {
    return this.error === null
      ? { status: this.status, pending: this.pending.length }
      : { status: this.status, pending: this.pending.length, error: this.error };
  }

  /**
   * Loads whatever a previous session left queued, then opens the socket.
   *
   * The queued operations are deliberately *not* applied to the document here:
   * their origins point at items this fresh `Doc` does not have yet. They are
   * replayed after `welcome`, once the state they were created against is back.
   */
  async start(): Promise<void> {
    this.pending = await this.options.outbox.all();
    if (this.destroyed) return;
    this.emit();
    this.open();
  }

  /** Queues locally-created operations — already applied to `doc` by the caller — and sends them if online. */
  push(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    this.pending.push(...ops);
    this.enqueueWrite(() => this.options.outbox.add(ops));
    this.emit();
    this.send(ops);
  }

  /**
   * Broadcasts this replica's cursor. Anchors only, never offsets (SPEC §8).
   *
   * Dropped silently while offline: presence is ephemeral, so a cursor position
   * from a dead connection is worthless by the time it could be delivered —
   * unlike an operation, which is queued precisely because it still matters
   * later. The next move after reconnecting resends it.
   *
   * Identical positions are not resent. That is the only rate limiting here:
   * every keystroke does put one small message on the wire, which at demo scale
   * is far cheaper than the coalescing timer it would take to avoid.
   */
  setPresence(anchor: OpId | null, focus: OpId | null): void {
    if (!this.socket || this.status !== 'online') return;
    const key = JSON.stringify([anchor, focus]);
    if (key === this.sentPresence) return;
    this.sentPresence = key;
    this.socket.send(serializeMessage({ t: 'presence', anchor, focus }));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    if (this.destroyed) return;
    this.setStatus('connecting');
    this.socket = this.connect(this.options.url, {
      onOpen: () => {
        this.setStatus('online');
        this.helloSentAt = performance.now();
        this.socket?.send(
          serializeMessage({
            t: 'hello',
            docId: this.options.docId,
            replica: this.options.replica,
            sinceSeq: this.sinceSeq,
          }),
        );
      },
      onMessage: (raw) => this.receive(raw),
      onClose: () => {
        this.socket = null;
        this.setStatus('offline');
        // Peers are dropped on disconnect at both ends: the server tells the
        // others, and this client forgets everyone rather than leaving frozen
        // carets on screen for a room it can no longer see.
        this.options.onPeers?.([]);
        // A reconnect starts from an unknown position, so the next cursor move
        // must go out even if it matches what the old connection last sent.
        this.sentPresence = '';
        this.scheduleReconnect();
      },
    });
  }

  /**
   * Reconnects with a capped exponential backoff. `retries` resets on
   * `welcome`, not on the socket opening: a server that accepts connections and
   * immediately drops them would otherwise reset the backoff every time and
   * turn it into a hot loop.
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.timer !== null || this.status === 'error') return;
    const index = Math.min(this.retries, this.backoff.length - 1);
    // Non-empty by construction: the default has five entries and a caller-supplied
    // array is clamped to its own last index.
    const delay = this.backoff[index]!;
    this.retries += 1;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** Retries immediately — the browser telling us the network is back beats waiting out the backoff. */
  retryNow(): void {
    if (this.destroyed || this.socket) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.retries = 0;
    this.open();
  }

  private receive(raw: string): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(raw);
    } catch (err) {
      console.error('[idem] discarding invalid server message', err);
      return;
    }
    if (message.t === 'welcome') {
      this.retries = 0;
      // A document the server cannot serve a replayable history for is fatal to
      // this client, but it must not be fatal to the *page*: an uncaught throw
      // here used to kill the editor mid-connect, which also stranded the
      // outbox — the queue could never drain because the code that resends it
      // never ran. Failing loudly and staying alive keeps those edits safe.
      try {
        this.applyWelcome(message.snapshot, message.ops, message.seq);
      } catch (err) {
        this.fail(
          'This document could not be loaded: the server sent a history that cannot be ' +
            'replayed. Your unsent edits are still queued. See docs/RECOVERY.md.',
          err,
        );
      }
    } else if (message.t === 'ops') {
      try {
        for (const op of message.ops) this.currentDoc.apply(op);
      } catch (err) {
        this.fail(
          'This document could not be updated: the server sent an operation that cannot be ' +
            'applied. Your unsent edits are still queued. See docs/RECOVERY.md.',
          err,
        );
        return;
      }
      this.sinceSeq = message.seq;
      // A client's own operations are broadcast back to it (SPEC §6 step 4).
      // That echo, carrying a `seq`, is the acknowledgement (SPEC §7).
      this.acknowledge(message.ops.map((op) => op.id));
      this.options.onChange();
    } else if (message.t === 'presence') {
      // Ephemeral (SPEC §8) — nothing here is stored or acknowledged. The
      // roster includes this replica; drop it, since a client already knows
      // where its own cursor is and drawing it twice is a visible bug.
      this.options.onPeers?.(message.peers.filter((peer) => peer.replica !== this.options.replica));
    } else if (message.t === 'error') {
      console.error(`[idem] server rejected a message [${message.code}]: ${message.message}`);
      // A room that has closed itself cannot take this client's edits, and
      // retrying would only produce the same answer. Say so, and keep the
      // outbox intact for a server that comes back healthy.
      if (message.code === 'E_ROOM_UNAVAILABLE') this.fail(message.message, null);
    }
  }

  /**
   * `welcome` is either snapshot-plus-tail or tail alone (SPEC §6), and it is
   * also where a reconnect settles up. In order:
   *
   * 1. Rebuild from what the server has. A snapshot replaces `doc` outright.
   * 2. Acknowledge queued operations whose effect is already in that state —
   *    before step 3, or replaying our own operations would make every one of
   *    them look acknowledged.
   * 3. Replay what is still queued, restoring local edits a snapshot just
   *    overwrote. Idempotent when it is the same document we already had.
   * 4. Resend the queue (SPEC §6 step 3).
   */
  private applyWelcome(snapshot: Snapshot | null, ops: readonly Op[], seq: number): void {
    if (snapshot) this.currentDoc = Doc.fromItems(this.options.replica, snapshot.items);
    for (const op of ops) this.currentDoc.apply(op);
    this.sinceSeq = seq;

    // Effect matching is only sound against a document that came entirely from
    // the server. Without a snapshot, `doc` still holds this client's own
    // unacknowledged edits, and every one of them would look like it had
    // landed — so in that case fall back to the plain rule: an operation is
    // acknowledged when it comes back carrying a `seq`.
    this.acknowledge(snapshot ? this.settledIds() : ops.map((op) => op.id));

    for (const op of this.pending) {
      try {
        this.currentDoc.apply(op);
      } catch (err) {
        // Only reachable if the server's state is missing an item this
        // operation was created against, which causal delivery rules out.
        // Keep it queued and let the server be the judge.
        console.error('[idem] could not replay a queued operation locally', err);
      }
    }

    this.options.onChange();
    this.send(this.pending);

    // M8's acceptance criterion is a wall-clock number, so the client reports
    // its own: hello sent → text on screen. See docs/BENCHMARKS.md.
    console.info(
      `[idem] loaded in ${(performance.now() - this.helloSentAt).toFixed(0)} ms ` +
        `(snapshot ${snapshot ? `${snapshot.items.length} items` : 'none'}, ` +
        `tail ${ops.length} ops, seq ${seq}, resent ${this.pending.length} queued ops)`,
    );
  }

  /**
   * Queued operations whose effect is already present in the state the server
   * just sent — they are durable, whatever route they took to get there.
   *
   * Only valid right after a snapshot rebuilt the document, when every item in
   * it came from the server.
   *
   * The plain rule ("it left the outbox when it came back with a `seq`") does
   * not cover one case: an operation the server accepted before a snapshot
   * subsumed it. Snapshots carry items, not the operations that produced them,
   * so on a reconnect from behind that snapshot a delete would never be
   * matched by id, would be resent on every future reconnect, and would sit in
   * the queue forever. Matching on *effect* closes that leak, and is sound for
   * the same reason resending is: an operation whose effect is already in the
   * document is one whose reapplication would be a no-op.
   */
  private settledIds(): OpId[] {
    if (this.pending.length === 0) return [];
    const items = new Map<string, Item>();
    for (const item of this.currentDoc.items) items.set(opKey(item.id), item);
    const settled: OpId[] = [];
    for (const op of this.pending) {
      const landed =
        op.kind === 'insert'
          ? items.has(opKey(op.id))
          : (items.get(opKey(op.target))?.deleted ?? false);
      if (landed) settled.push(op.id);
    }
    return settled;
  }

  private acknowledge(ids: readonly OpId[]): void {
    if (ids.length === 0 || this.pending.length === 0) return;
    const acked = new Set(ids.map(opKey));
    const before = this.pending.length;
    this.pending = this.pending.filter((op) => !acked.has(opKey(op.id)));
    if (this.pending.length === before) return;
    this.enqueueWrite(() => this.options.outbox.ack(ids));
    this.emit();
  }

  private send(ops: readonly Op[]): void {
    if (ops.length === 0 || !this.socket || this.status !== 'online') return;
    this.socket.send(serializeMessage({ t: 'ops', ops: [...ops] }));
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((err: unknown) => {
      console.error('[idem] outbox write failed; the queue is now memory-only', err);
    });
  }

  /** Awaits every outbox write started so far. For tests and for a deliberate flush. */
  async flushWrites(): Promise<void> {
    await this.writes;
  }

  /**
   * Stops this client for a reason retrying cannot fix, without losing the
   * queue. The socket is closed and no reconnect is scheduled: the operations
   * stay in IndexedDB, so a reload against a healthy server resends them.
   */
  private fail(message: string, cause: unknown): void {
    if (cause !== null) console.error('[idem]', message, cause);
    this.error = message;
    this.status = 'error';
    this.options.onPeers?.([]);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.emit();
  }

  private setStatus(status: ConnectionStatus): void {
    // 'error' is terminal for this client — nothing may quietly promote it back
    // to 'online' and imply the document is usable again.
    if (this.status === 'error' || this.status === status) return;
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.options.onState(this.state);
  }
}
