import { afterEach, describe, expect, it } from 'vitest';

import { PALETTE_SIZE, pickIdentity } from '../src/presence.js';
import { createHarness } from './ws-harness.js';

/**
 * Presence (M10, SPEC §6/§8): ephemeral cursor broadcast, per-replica names and
 * colors handed out by the server, peers dropped on disconnect.
 */

const harness = createHarness();
afterEach(() => harness.stop());

const anonymous = { name: expect.any(String), color: expect.any(String) };

describe('peer identity', () => {
  it('is stable for a replica and distinct for everyone already in the room', () => {
    expect(pickIdentity('replica-a', new Set())).toEqual(pickIdentity('replica-a', new Set()));

    const taken = new Set<string>();
    const names = new Set<string>();
    const colors = new Set<string>();
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const identity = pickIdentity(`replica-${i}`, taken);
      taken.add(identity.name);
      names.add(identity.name);
      colors.add(identity.color);
    }
    expect(names.size).toBe(PALETTE_SIZE);
    expect(colors.size).toBe(PALETTE_SIZE);
  });

  it('falls back to the preferred slot once the palette is exhausted, rather than failing', () => {
    const everyName = new Set(
      [...Array(PALETTE_SIZE).keys()].map((i) => pickIdentity(`seed-${i}`, new Set()).name),
    );
    // Every slot is spoken for; assignment degrades into ambiguity, not an error.
    expect(pickIdentity('replica-a', everyName)).toEqual(pickIdentity('replica-a', new Set()));
  });
});

describe('presence broadcast (M10)', () => {
  it('announces a peer on join and tells the newcomer who is already there', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    expect(await a.nextRoster()).toEqual([
      { replica: 'a', ...anonymous, anchor: null, focus: null },
    ]);

    const b = await harness.join(url, 'b');
    // Both sides learn about each other from the same broadcast.
    const [onA, onB] = await Promise.all([a.nextRoster(), b.nextRoster()]);
    expect(onA.map((peer) => peer.replica)).toEqual(['a', 'b']);
    expect(onB).toEqual(onA);
    expect(onA[0]!.color).not.toBe(onA[1]!.color);
    expect(onA[0]!.name).not.toBe(onA[1]!.name);
  });

  it('relays a cursor as anchors, keeping the identity assigned at join', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    const b = await harness.join(url, 'b');
    const [joinRoster] = await Promise.all([a.nextRoster(), b.nextRoster()]);
    // Non-null: `b` just joined this room, so it is in the roster `a` received.
    const identityOfB = joinRoster.find((peer) => peer.replica === 'b')!;

    b.send({
      t: 'presence',
      anchor: { lamport: 3, replica: 'b' },
      focus: { lamport: 7, replica: 'a' },
    });

    const [onA, onB] = await Promise.all([a.nextRoster(), b.nextRoster()]);
    expect(onB).toEqual(onA);
    expect(onA.find((peer) => peer.replica === 'b')).toEqual({
      replica: 'b',
      name: identityOfB.name,
      color: identityOfB.color,
      anchor: { lamport: 3, replica: 'b' },
      focus: { lamport: 7, replica: 'a' },
    });
    // One peer moving leaves every other entry exactly as it was.
    expect(onA.find((peer) => peer.replica === 'a')?.anchor).toBeNull();
  });

  it('drops a peer on disconnect', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    const b = await harness.join(url, 'b');
    await Promise.all([a.nextRoster(), b.nextRoster()]);

    b.close();
    expect(await a.nextRoster()).toEqual([
      { replica: 'a', ...anonymous, anchor: null, focus: null },
    ]);
  });

  it('leaves nothing behind: a cursor is gone from later rosters once its socket closes', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    const b = await harness.join(url, 'b');
    await Promise.all([a.nextRoster(), b.nextRoster()]);

    a.send({ t: 'presence', anchor: null, focus: { lamport: 1, replica: 'a' } });
    await Promise.all([a.nextRoster(), b.nextRoster()]);
    a.close();

    // `b` observing the departure is also what makes this deterministic: the
    // server has provably processed the close before the next client joins.
    expect((await b.nextRoster()).map((peer) => peer.replica)).toEqual(['b']);

    // And it is gone from a *fresh* roster too, not merely from that one
    // broadcast — presence is ephemeral (SPEC §8), so there is nowhere for a
    // dead peer's cursor to have been kept.
    const c = await harness.join(url, 'c');
    const roster = await c.nextRoster();
    expect(roster.map((peer) => peer.replica)).toEqual(['b', 'c']);
    expect(roster.every((peer) => peer.focus === null)).toBe(true);
  });

  it('does not leak presence between documents', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();

    const z = await harness.join(url, 'z', { docId: 'doc-2' });
    expect(await z.nextRoster()).toEqual([
      { replica: 'z', ...anonymous, anchor: null, focus: null },
    ]);

    z.send({ t: 'presence', anchor: null, focus: { lamport: 1, replica: 'z' } });
    expect((await z.nextRoster()).map((peer) => peer.replica)).toEqual(['z']);

    // `a` is in another room and must have heard none of it — not the join, not
    // the cursor. Presence is scoped to a document like every other message.
    expect(await a.silentFor(200)).toBe(true);
  });
});
