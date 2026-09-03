import { describe, expect, it } from 'vitest';

import { Room, RoomRegistry } from '../src/rooms.js';
import { createMemoryStore, type OpStore } from '../src/store.js';

const insert = (lamport: number, replica: string, content: string) => ({
  kind: 'insert' as const,
  id: { lamport, replica },
  originLeft: null,
  content,
});

async function freshRoom(store: OpStore = createMemoryStore()): Promise<Room> {
  return Room.load('doc-1', store);
}

describe('Room', () => {
  it('welcome on an empty room reports seq 0 and no ops', async () => {
    const room = await freshRoom();
    expect(room.welcome(0)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 0 });
  });

  it('assigns increasing seq to new ops and appends them to the log', async () => {
    const room = await freshRoom();
    const first = room.applyOps([insert(1, 'a', 'H')]);
    const second = room.applyOps([insert(2, 'a', 'I')]);

    expect(first).toEqual({ seq: 1, ops: [insert(1, 'a', 'H')] });
    expect(second).toEqual({ seq: 2, ops: [insert(2, 'a', 'I')] });
  });

  it('deduplicates on the op id, per SPEC §5 — a full-duplicate batch yields null', async () => {
    const room = await freshRoom();
    room.applyOps([insert(1, 'a', 'H')]);
    expect(room.applyOps([insert(1, 'a', 'H')])).toBeNull();
  });

  it('accepts only the new ops in a mixed batch, keyed on seq at time of the call', async () => {
    const room = await freshRoom();
    room.applyOps([insert(1, 'a', 'H')]);
    const result = room.applyOps([insert(1, 'a', 'H'), insert(2, 'a', 'I')]);
    expect(result).toEqual({ seq: 2, ops: [insert(2, 'a', 'I')] });
  });

  it('welcome serves the tail after sinceSeq, and an empty tail once caught up', async () => {
    const room = await freshRoom();
    room.applyOps([insert(1, 'a', 'H')]);
    room.applyOps([insert(2, 'a', 'I')]);

    expect(room.welcome(0)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });
    expect(room.welcome(1)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(2, 'a', 'I')],
      seq: 2,
    });
    expect(room.welcome(2)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 2 });
  });

  it('broadcast reaches every joined client and not one that left', async () => {
    const room = await freshRoom();
    const received: string[] = [];
    room.join({ replica: 'a', send: (raw) => received.push(`a:${raw}`) });
    room.join({ replica: 'b', send: (raw) => received.push(`b:${raw}`) });

    room.broadcast('hi');
    expect(received.sort()).toEqual(['a:hi', 'b:hi']);

    received.length = 0;
    room.leave('a');
    room.broadcast('again');
    expect(received).toEqual(['b:again']);
  });

  it('load hydrates seq and dedup state from whatever the store already has (restart recovery)', async () => {
    const store = createMemoryStore();
    await store.append('doc-1', [
      { seq: 1, op: insert(1, 'a', 'H') },
      { seq: 2, op: insert(2, 'a', 'I') },
    ]);

    const room = await Room.load('doc-1', store);
    expect(room.welcome(0)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });
    // A resend of an op the store already had is deduplicated from the moment of hydration.
    expect(room.applyOps([insert(1, 'a', 'H')])).toBeNull();
    expect(room.applyOps([insert(3, 'a', 'J')])).toEqual({ seq: 3, ops: [insert(3, 'a', 'J')] });
  });

  it('applyOps persists accepted ops to the store', async () => {
    const store = createMemoryStore();
    const room = await Room.load('doc-1', store);
    room.applyOps([insert(1, 'a', 'H')]);
    await room.flush();
    expect(await store.load('doc-1')).toEqual([insert(1, 'a', 'H')]);
  });
});

describe('RoomRegistry', () => {
  it('returns the same room for the same docId and a different one for another', async () => {
    const registry = new RoomRegistry(createMemoryStore());
    const a1 = await registry.getOrCreate('doc-1');
    const a2 = await registry.getOrCreate('doc-1');
    const b = await registry.getOrCreate('doc-2');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
