import { describe, expect, it } from 'vitest';

import { Room, RoomRegistry } from '../src/rooms.js';

const insert = (lamport: number, replica: string, content: string) => ({
  kind: 'insert' as const,
  id: { lamport, replica },
  originLeft: null,
  content,
});

describe('Room', () => {
  it('welcome on an empty room reports seq 0 and no ops', () => {
    const room = new Room('doc-1');
    expect(room.welcome(0)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 0 });
  });

  it('assigns increasing seq to new ops and appends them to the log', () => {
    const room = new Room('doc-1');
    const first = room.applyOps([insert(1, 'a', 'H')]);
    const second = room.applyOps([insert(2, 'a', 'I')]);

    expect(first).toEqual({ seq: 1, ops: [insert(1, 'a', 'H')] });
    expect(second).toEqual({ seq: 2, ops: [insert(2, 'a', 'I')] });
  });

  it('deduplicates on the op id, per SPEC §5 — a full-duplicate batch yields null', () => {
    const room = new Room('doc-1');
    room.applyOps([insert(1, 'a', 'H')]);
    expect(room.applyOps([insert(1, 'a', 'H')])).toBeNull();
  });

  it('accepts only the new ops in a mixed batch, keyed on seq at time of the call', () => {
    const room = new Room('doc-1');
    room.applyOps([insert(1, 'a', 'H')]);
    const result = room.applyOps([insert(1, 'a', 'H'), insert(2, 'a', 'I')]);
    expect(result).toEqual({ seq: 2, ops: [insert(2, 'a', 'I')] });
  });

  it('welcome serves the tail after sinceSeq, and an empty tail once caught up', () => {
    const room = new Room('doc-1');
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

  it('broadcast reaches every joined client and not one that left', () => {
    const room = new Room('doc-1');
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
});

describe('RoomRegistry', () => {
  it('returns the same room for the same docId and a different one for another', () => {
    const registry = new RoomRegistry();
    const a1 = registry.getOrCreate('doc-1');
    const a2 = registry.getOrCreate('doc-1');
    const b = registry.getOrCreate('doc-2');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
