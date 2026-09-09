import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryOutbox, type Outbox } from '../app/sync/outbox';
import { SyncClient, type SyncState } from '../app/sync/sync-client';
import { createFakeNetwork, settle, type FakeNetwork } from './fake-server';

/**
 * M9's offline path, headless: queue while disconnected, resend on reconnect,
 * acknowledge, converge. The acceptance criterion is the two-window demo in
 * `e2e/offline.spec.ts`; these tests are how the logic under it is pinned down
 * to specific, fast assertions.
 */

interface Timers {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  /** Fires every pending timer, then lets the network settle. */
  run(): Promise<void>;
  readonly delays: number[];
}

function createTimers(): Timers {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    setTimer(fn, ms) {
      const handle = next++;
      pending.set(handle, fn);
      delays.push(ms);
      return handle;
    },
    clearTimer(handle) {
      pending.delete(handle);
    },
    async run() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
      await settle();
    },
    delays,
  };
}

let net: FakeNetwork;
let timers: Timers;
const started: SyncClient[] = [];

beforeEach(() => {
  net = createFakeNetwork();
  timers = createTimers();
  started.length = 0;
});

afterEach(() => {
  for (const client of started) client.destroy();
});

function createClient(replica: string, outbox: Outbox = createMemoryOutbox()): SyncClient {
  const client = new SyncClient({
    url: 'ws://test/ws',
    docId: 'doc-1',
    replica,
    outbox,
    connect: net.connect,
    onChange: () => {},
    onState: () => {},
    backoffMs: [10, 20, 40],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  started.push(client);
  return client;
}

async function start(client: SyncClient): Promise<void> {
  await client.start();
  await settle();
}

/** Types one character at a time, as the editor does — one `push` per keystroke. */
function typeText(client: SyncClient, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    client.push([client.doc.localInsert(at + i, text[i]!)]);
  }
}

describe('offline queue', () => {
  it('holds operations created while disconnected and sends them on reconnect', async () => {
    const outbox = createMemoryOutbox();
    const client = createClient('a', outbox);
    await start(client);
    expect(client.state.status).toBe('online');

    net.setOnline(false);
    await settle();
    expect(client.state.status).toBe('offline');

    typeText(client, 0, 'offline');
    await client.flushWrites();
    expect(client.state.pending).toBe(7);
    expect(await outbox.all()).toHaveLength(7);
    // The text is on screen the moment it is typed — the queue is about
    // durability, never about withholding the user's own edit from them.
    expect(client.doc.toString()).toBe('offline');
    expect(net.log).toHaveLength(0);

    net.setOnline(true);
    await timers.run();

    expect(client.state.status).toBe('online');
    expect(net.text()).toBe('offline');
    await client.flushWrites();
    expect(client.state.pending).toBe(0);
    expect(await outbox.all()).toHaveLength(0);
  });

  it('keeps an operation queued until the server echoes it back', async () => {
    const outbox = createMemoryOutbox();
    const client = createClient('a', outbox);
    await start(client);

    const op = client.doc.localInsert(0, 'x');
    client.push([op]);
    // Sent, but not yet acknowledged: the echo carrying a `seq` has not
    // arrived, so the operation is still the client's responsibility.
    expect(client.state.pending).toBe(1);

    await settle();
    await client.flushWrites();
    expect(client.state.pending).toBe(0);
    expect(await outbox.all()).toHaveLength(0);
  });

  it('survives a reload while offline — a new replica resends the old queue', async () => {
    // One `Outbox` instance standing in for one IndexedDB database: the
    // process restarts around it, exactly as a page reload restarts around
    // the stored queue.
    const outbox = createMemoryOutbox();
    const before = createClient('before-reload', outbox);
    await start(before);
    net.setOnline(false);
    await settle();

    typeText(before, 0, 'draft');
    await before.flushWrites();
    before.destroy();

    net.setOnline(true);
    const after = createClient('after-reload', outbox);
    await start(after);
    await after.flushWrites();

    expect(net.text()).toBe('draft');
    expect(after.doc.toString()).toBe('draft');
    expect(after.state.pending).toBe(0);
    expect(await outbox.all()).toHaveLength(0);
  });

  it('acknowledges an operation a snapshot has already subsumed', async () => {
    // The one case the "it came back with a seq" rule cannot cover: the server
    // accepted the operation, the echo was lost with the connection, and a
    // snapshot then replaced the log entry with its effect. Without effect
    // matching this delete would be resent on every future reconnect forever.
    const outbox = createMemoryOutbox();
    const client = createClient('a', outbox);
    await start(client);
    typeText(client, 0, 'ab');
    await settle();
    await client.flushWrites();
    expect(client.state.pending).toBe(0);

    const remove = client.doc.localDelete(1);
    expect(remove).not.toBeNull();
    client.push([remove!]);
    // The server accepts it, then the connection dies before the echo arrives.
    net.setOnline(false);
    await settle();
    await client.flushWrites();
    expect(client.state.pending).toBe(1);
    expect(net.log).toHaveLength(3);

    net.takeSnapshot();
    net.setOnline(true);
    await timers.run();
    await client.flushWrites();

    expect(client.doc.toString()).toBe('a');
    expect(client.state.pending).toBe(0);
    expect(await outbox.all()).toHaveLength(0);
  });

  it('is unharmed by resending operations the server already has', async () => {
    const client = createClient('a');
    await start(client);
    typeText(client, 0, 'hi');
    await settle();

    // Force the resend path a reconnect would take, twice over, against a
    // server that already has everything: at-least-once delivery is the design
    // (SPEC §7), so this must be a no-op end to end.
    const ops = [...net.log];
    client.push(ops);
    await settle();
    client.push(ops);
    await settle();

    expect(net.log).toHaveLength(2);
    expect(net.text()).toBe('hi');
    expect(client.doc.toString()).toBe('hi');
  });

  it('backs off between reconnect attempts and resets once a welcome arrives', async () => {
    const client = createClient('a');
    await start(client);

    net.setOnline(false);
    await settle();
    await timers.run(); // first retry, still offline
    await timers.run(); // second retry, still offline
    expect(timers.delays).toEqual([10, 20, 40]);
    expect(client.state.status).toBe('offline');

    net.setOnline(true);
    await timers.run();
    expect(client.state.status).toBe('online');

    net.setOnline(false);
    await settle();
    // Reset: the next outage starts at the front of the backoff, not where the
    // last one left off.
    expect(timers.delays).toEqual([10, 20, 40, 10]);
  });

  it('reports status and queue depth to the connection indicator', async () => {
    const states: SyncState[] = [];
    const client = new SyncClient({
      url: 'ws://test/ws',
      docId: 'doc-1',
      replica: 'a',
      outbox: createMemoryOutbox(),
      connect: net.connect,
      onChange: () => {},
      onState: (state) => states.push(state),
      backoffMs: [10],
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    started.push(client);

    await start(client);
    net.setOnline(false);
    await settle();
    typeText(client, 0, 'ab');

    expect(states.map((state) => state.status)).toContain('connecting');
    expect(states.at(-1)).toEqual({ status: 'offline', pending: 2 });

    net.setOnline(true);
    await timers.run();
    expect(states.at(-1)).toEqual({ status: 'online', pending: 0 });
  });
});

describe('the headline demo', () => {
  it('two replicas, both offline, conflicting edits in one sentence, identical after reconnect', async () => {
    const alice = createClient('alice');
    const bob = createClient('bob');
    await start(alice);
    await start(bob);

    typeText(alice, 0, 'the meeting is at .');
    await settle();
    expect(bob.doc.toString()).toBe('the meeting is at .');

    // Both go dark, and both edit the same sentence — the same position in it.
    net.setOnline(false);
    await settle();
    expect(alice.state.status).toBe('offline');
    expect(bob.state.status).toBe('offline');

    typeText(alice, 18, 'noon');
    typeText(bob, 18, 'four');
    expect(alice.doc.toString()).toBe('the meeting is at noon.');
    expect(bob.doc.toString()).toBe('the meeting is at four.');

    net.setOnline(true);
    await timers.run();
    await timers.run();
    await settle();

    expect(alice.state.status).toBe('online');
    expect(bob.state.status).toBe('online');
    expect(alice.state.pending).toBe(0);
    expect(bob.state.pending).toBe(0);

    const merged = alice.doc.toString();
    expect(bob.doc.toString()).toBe(merged);
    expect(net.text()).toBe(merged);
    // Convergence is the guarantee; the exact interleaving is RGA's business.
    // What matters for M9 is that nothing was dropped by going offline — every
    // character both replicas typed is present, exactly once.
    const sorted = (text: string) => [...text].sort().join('');
    expect(sorted(merged)).toBe(sorted('the meeting is at .noonfour'));
    expect(merged.startsWith('the meeting is at ')).toBe(true);
    expect(merged.endsWith('.')).toBe(true);
  });
});

describe('a document the server cannot serve', () => {
  /**
   * The client half of the same regression. A `welcome` carrying a history that
   * cannot be replayed used to throw straight out of the message handler. That
   * killed the page — and with it the code that resends the outbox, so the
   * queue could never drain and the edits sat there looking permanent.
   */
  it('reports the failure instead of throwing out of the handler, and still captures edits', async () => {
    const outbox = createMemoryOutbox();
    const client = createClient('a', outbox);
    await start(client);

    // A delete for an item no insert ever created — a log with a hole in it,
    // which is what a room that lost a write leaves behind.
    net.deliverRaw({
      t: 'welcome',
      snapshot: { seq: 9, items: [] },
      ops: [
        {
          kind: 'delete',
          id: { lamport: 9, replica: 'ghost' },
          target: { lamport: 1, replica: 'ghost' },
        },
      ],
      seq: 9,
    });
    await settle();

    expect(client.state.status).toBe('error');
    expect(client.state.error).toMatch(/could not be loaded/);

    // The whole point of not throwing: the client is still a working object, so
    // anything typed after the failure is still queued and still durable rather
    // than disappearing along with the page.
    typeText(client, 0, 'mine');
    await client.flushWrites();
    expect(client.state.pending).toBe(4);
    expect(await outbox.all()).toHaveLength(4);
  });

  it('stops retrying once it has failed, rather than reconnecting into the same wall', async () => {
    const client = createClient('a');
    await start(client);

    net.deliverRaw({
      t: 'welcome',
      snapshot: { seq: 1, items: [] },
      ops: [
        {
          kind: 'delete',
          id: { lamport: 1, replica: 'ghost' },
          target: { lamport: 7, replica: 'ghost' },
        },
      ],
      seq: 1,
    });
    await settle();
    expect(client.state.status).toBe('error');

    const before = timers.delays.length;
    await timers.run();
    expect(timers.delays.length).toBe(before);
    expect(client.state.status).toBe('error');
  });

  it('surfaces a room the server has closed, without discarding the queue', async () => {
    const outbox = createMemoryOutbox();
    const client = createClient('a', outbox);
    await start(client);

    net.deliverRaw({
      t: 'error',
      code: 'E_ROOM_UNAVAILABLE',
      message: 'Document doc-1 stopped accepting operations because a write to the log failed.',
    });
    await settle();

    expect(client.state.status).toBe('error');
    expect(client.state.error).toMatch(/stopped accepting operations/);

    // Edits made after the server gave up are still written to IndexedDB, which
    // is what makes them survive until a healthy server is back.
    typeText(client, 0, 'hi');
    await client.flushWrites();
    expect(await outbox.all()).toHaveLength(2);
  });
});
