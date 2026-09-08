import { Doc, visibleIndexToAnchor, type OpId } from '@idem/crdt';
import type { Peer } from '@idem/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryOutbox } from '../app/sync/outbox';
import { resolvePeerRanges, type PeerRange } from '../app/sync/presence';
import { SyncClient } from '../app/sync/sync-client';
import { createFakeNetwork, settle, type FakeNetwork } from './fake-server';

/**
 * M10's acceptance criterion, headless: *a remote caret sits in the correct
 * place while you type before it, after it, and on top of it.*
 *
 * Those three cases are decided entirely by `resolvePeerRanges`, which is why
 * it is a pure function over items and anchors. The CodeMirror decorations
 * around it are drawing; this is the part that can be wrong.
 */

function peerAt(doc: Doc, visibleIndex: number, overrides: Partial<Peer> = {}): Peer {
  const anchor = visibleIndexToAnchor(doc.items, visibleIndex);
  return {
    replica: 'them',
    name: 'Otter',
    color: '#d2431a',
    anchor,
    focus: anchor,
    ...overrides,
  };
}

/** Where a peer's caret resolves to right now, or `null` if it was skipped. */
function caretOf(doc: Doc, peer: Peer, self = 'me'): number | null {
  const [range] = resolvePeerRanges(doc.items, [peer], self);
  return range?.head ?? null;
}

describe('resolving a peer caret (M10)', () => {
  /** A local document reading `HELLO`, authored by this replica. */
  function hello(): Doc {
    const doc = new Doc('me');
    for (const [i, char] of [...'HELLO'].entries()) doc.localInsert(i, char);
    return doc;
  }

  it('holds its place when you type before it', () => {
    const doc = hello();
    const peer = peerAt(doc, 3); // HEL|LO
    expect(caretOf(doc, peer)).toBe(3);

    doc.localInsert(0, 'X'); // XHEL|LO
    expect(caretOf(doc, peer)).toBe(4);

    doc.localInsert(1, 'Y'); // XYHEL|LO
    expect(caretOf(doc, peer)).toBe(5);
    expect(doc.toString()).toBe('XYHELLO');
  });

  it('holds its place when you type after it', () => {
    const doc = hello();
    const peer = peerAt(doc, 3);

    doc.localInsert(5, '!');
    doc.localInsert(4, '?');
    expect(caretOf(doc, peer)).toBe(3);
    expect(doc.toString()).toBe('HELL?O!');
  });

  it('stays to the left of text you type on top of it', () => {
    const doc = hello();
    const peer = peerAt(doc, 3);

    // Typing at exactly the peer's position: the new character is inserted to
    // the *right* of the item they are anchored to, so their caret does not
    // move — it now sits in front of what you just typed, which is where the
    // person on the other end still has their cursor.
    doc.localInsert(3, 'Z');
    expect(doc.toString()).toBe('HELZLO');
    expect(caretOf(doc, peer)).toBe(3);
  });

  it('walks left through tombstones when its own anchor is deleted', () => {
    const doc = hello();
    const peer = peerAt(doc, 3); // anchored to the first L

    doc.localDelete(2); // delete that L — HE|LO
    expect(doc.toString()).toBe('HELO');
    // The anchor is a tombstone now, so the caret falls back to the nearest
    // visible item to its left (SPEC §8) rather than vanishing or jumping.
    expect(caretOf(doc, peer)).toBe(2);

    doc.localDelete(1);
    doc.localDelete(0);
    expect(caretOf(doc, peer)).toBe(0);
  });

  it('renders a selection as a span, and a collapsed cursor as an empty one', () => {
    const doc = hello();
    const selection = peerAt(doc, 1, { focus: visibleIndexToAnchor(doc.items, 4) });
    const [range] = resolvePeerRanges(doc.items, [selection], 'me');
    expect(range).toMatchObject({ from: 1, to: 4, head: 4 });

    const collapsed = resolvePeerRanges(doc.items, [peerAt(doc, 2)], 'me')[0];
    expect(collapsed).toMatchObject({ from: 2, to: 2, head: 2 });
  });

  it('orders a backwards selection so from precedes to, keeping the caret at the head', () => {
    const doc = hello();
    const backwards = peerAt(doc, 4, { focus: visibleIndexToAnchor(doc.items, 1) });
    expect(resolvePeerRanges(doc.items, [backwards], 'me')[0]).toMatchObject({
      from: 1,
      to: 4,
      head: 1,
    });
  });

  it('never draws your own cursor', () => {
    const doc = hello();
    const mine = peerAt(doc, 2, { replica: 'me' });
    expect(resolvePeerRanges(doc.items, [mine, peerAt(doc, 3)], 'me')).toHaveLength(1);
  });

  it('skips a peer anchored to an item this replica has not seen', () => {
    const doc = hello();
    const unknown: OpId = { lamport: 99, replica: 'ghost' };
    const peer = peerAt(doc, 2, { anchor: unknown, focus: unknown });
    // A roster and the operation stream are separate messages, so a peer can
    // briefly reference an item that has not arrived. Skipping is correct;
    // throwing would take the whole editor down over a decoration.
    expect(resolvePeerRanges(doc.items, [peer, peerAt(doc, 1)], 'me')).toHaveLength(1);
  });

  it('carries name and colour through untouched, for the caret label', () => {
    const doc = hello();
    const range = resolvePeerRanges(
      doc.items,
      [peerAt(doc, 1, { replica: 'them', name: 'Heron', color: '#1a6fd2' })],
      'me',
    )[0] as PeerRange;
    expect(range).toMatchObject({ replica: 'them', name: 'Heron', color: '#1a6fd2' });
  });
});

// --- The wire half: sending and receiving the roster ------------------------

let net: FakeNetwork;
const started: SyncClient[] = [];
/** Pending reconnect timers, fired by hand so a reconnect is a step, not a wait. */
let pendingTimers: (() => void)[] = [];

async function runTimers(): Promise<void> {
  const due = pendingTimers;
  pendingTimers = [];
  for (const fn of due) fn();
  await settle();
}

beforeEach(() => {
  net = createFakeNetwork();
  started.length = 0;
  pendingTimers = [];
});

afterEach(() => {
  for (const client of started) client.destroy();
});

function createClient(replica: string, onPeers: (peers: readonly Peer[]) => void): SyncClient {
  const client = new SyncClient({
    url: 'ws://test/ws',
    docId: 'doc-1',
    replica,
    outbox: createMemoryOutbox(),
    connect: net.connect,
    onChange: () => {},
    onState: () => {},
    onPeers,
    backoffMs: [10],
    setTimer: (fn) => pendingTimers.push(fn),
    clearTimer: () => {},
  });
  started.push(client);
  return client;
}

describe('presence over the wire (M10)', () => {
  it('reports other peers and never this replica itself', async () => {
    const seenByA: (readonly Peer[])[] = [];
    const a = createClient('a', (peers) => seenByA.push(peers));
    await a.start();
    await settle();
    expect(seenByA.at(-1)).toEqual([]);

    const b = createClient('b', () => {});
    await b.start();
    await settle();
    expect(seenByA.at(-1)?.map((peer) => peer.replica)).toEqual(['b']);

    b.setPresence(null, { lamport: 4, replica: 'b' });
    await settle();
    expect(seenByA.at(-1)?.[0]).toMatchObject({
      replica: 'b',
      anchor: null,
      focus: { lamport: 4, replica: 'b' },
    });
  });

  it('drops every peer when the connection goes down', async () => {
    const seenByA: (readonly Peer[])[] = [];
    const a = createClient('a', (peers) => seenByA.push(peers));
    await a.start();
    const b = createClient('b', () => {});
    await b.start();
    await settle();
    expect(seenByA.at(-1)).toHaveLength(1);

    net.setOnline(false);
    await settle();
    // A roster from a dead connection is a lie by the next frame, so it is
    // forgotten rather than left on screen as a frozen caret.
    expect(seenByA.at(-1)).toEqual([]);
  });

  it('does not put an unchanged cursor on the wire', async () => {
    const seenByA: (readonly Peer[])[] = [];
    const a = createClient('a', (peers) => seenByA.push(peers));
    const b = createClient('b', () => {});
    await a.start();
    await b.start();
    await settle();

    const focus: OpId = { lamport: 1, replica: 'b' };
    b.setPresence(null, focus);
    await settle();
    const afterFirst = seenByA.length;

    // A different object with the same anchors is the same cursor.
    b.setPresence(null, { ...focus });
    await settle();
    expect(seenByA.length).toBe(afterFirst);

    b.setPresence(null, { lamport: 2, replica: 'b' });
    await settle();
    expect(seenByA.length).toBeGreaterThan(afterFirst);
  });

  it('resends an unchanged cursor after a reconnect, since the room forgot it', async () => {
    const seenByA: (readonly Peer[])[] = [];
    const a = createClient('a', (peers) => seenByA.push(peers));
    const b = createClient('b', () => {});
    await a.start();
    await b.start();
    await settle();

    const focus: OpId = { lamport: 1, replica: 'b' };
    b.setPresence(null, focus);
    await settle();
    expect(seenByA.at(-1)?.[0]?.focus).toEqual(focus);

    net.setOnline(false);
    await settle();
    net.setOnline(true);
    await runTimers();
    expect(seenByA.at(-1)).toHaveLength(1);
    // `b`'s cursor died with its socket, so the roster `a` now has is blank...
    expect(seenByA.at(-1)?.[0]?.focus).toBeNull();

    // ...and the same position must go back out, even though it never changed.
    b.setPresence(null, focus);
    await settle();
    expect(seenByA.at(-1)?.[0]?.focus).toEqual(focus);
  });

  it('drops a cursor sent while offline rather than queueing it', async () => {
    const a = createClient('a', () => {});
    await a.start();
    await settle();

    net.setOnline(false);
    await settle();
    // Presence is ephemeral: unlike an operation, a stale cursor position is
    // worth nothing by the time the socket comes back, so nothing is queued.
    expect(() => a.setPresence(null, { lamport: 1, replica: 'a' })).not.toThrow();
    expect(a.state.pending).toBe(0);
  });
});
