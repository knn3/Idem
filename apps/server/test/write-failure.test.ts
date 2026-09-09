import { describe, expect, it } from 'vitest';

import { Room, RoomUnavailableError } from '../src/rooms.js';
import { createMemoryStore, type OpStore } from '../src/store.js';

/**
 * The regression this file exists for.
 *
 * A room used to log a failed `op_log` append and carry on. Clients kept
 * receiving `seq` numbers — which is how M9 defines "acknowledged", so their
 * outboxes emptied — while nothing reached disk. The log then had a hole in it,
 * and the first delete that *did* persist referenced an insert that never had.
 * From that moment the document was unloadable: every new client threw
 * replaying it, and snapshots could never be materialized again.
 *
 * A real database produced exactly that: 228 operations acknowledged and lost,
 * a log starting at seq 229 with a delete for an item nothing had inserted.
 */

const insert = (lamport: number, replica: string, content: string) =>
  ({ kind: 'insert', id: { lamport, replica }, originLeft: null, content }) as const;

const remove = (lamport: number, replica: string, target: { lamport: number; replica: string }) =>
  ({ kind: 'delete', id: { lamport, replica }, target }) as const;

/** A store whose appends fail from `failFrom` onwards, as a dead database does. */
function brittleStore(failFrom: number): OpStore & { appended: number } {
  const inner = createMemoryStore();
  let appended = 0;
  const store = {
    ...inner,
    async append(docId: string, entries: Parameters<OpStore['append']>[1]) {
      appended += entries.length;
      if (appended >= failFrom) throw new Error('connection terminated');
      return inner.append(docId, entries);
    },
    get appended() {
      return appended;
    },
  };
  return store as OpStore & { appended: number };
}

describe('a room that loses a durable write', () => {
  it('stops accepting operations instead of acknowledging ones it cannot store', async () => {
    // Fails from the second appended operation onwards.
    const room = await Room.load('doc-1', brittleStore(2));

    expect(room.applyOps([insert(1, 'a', 'H')])).not.toBeNull();
    await room.flush();
    expect(room.failed).toBe(false);

    room.applyOps([insert(2, 'a', 'I')]);
    await room.flush();
    expect(room.failed).toBe(true);

    // From here nothing may come back with a `seq`. A `seq` is the client's
    // signal to drop the operation from its outbox, and nothing is being stored.
    expect(() => room.applyOps([insert(3, 'a', '!')])).toThrow(RoomUnavailableError);
    expect(() => room.applyOps([insert(4, 'a', '?')])).toThrow(RoomUnavailableError);
  });

  it('still acknowledges the one batch whose write is already in flight', async () => {
    // An honest statement of what this fix does not cover. `seq` is assigned
    // synchronously and the broadcast does not wait for the disk (SPEC §9
    // allows the in-memory counter), so the batch that fails has already been
    // acknowledged by the time the failure is known. The window is one batch,
    // and the room closes immediately after it — which is what turns permanent
    // corruption into a single lost batch that clients resend on reconnect.
    const room = await Room.load('doc-1', brittleStore(1));
    expect(room.applyOps([insert(1, 'a', 'H')])).toEqual({ seq: 1, ops: [insert(1, 'a', 'H')] });
    await room.flush();
    expect(room.failed).toBe(true);
  });

  it('carries a code and says what to do about it', async () => {
    const room = await Room.load('doc-1', brittleStore(1));
    room.applyOps([insert(1, 'a', 'H')]);
    await room.flush();

    try {
      room.applyOps([insert(2, 'a', 'I')]);
      expect.unreachable('a failed room must refuse operations');
    } catch (err) {
      expect(err).toBeInstanceOf(RoomUnavailableError);
      expect((err as RoomUnavailableError).code).toBe('E_ROOM_UNAVAILABLE');
      expect((err as Error).message).toMatch(/outbox/);
    }
  });

  it('never produces the hole that made a real log unreplayable', async () => {
    // The shape of the original corruption: an insert is lost, and a delete
    // targeting it lands afterwards. Refusing everything after the first
    // failure is what makes that sequence unreachable.
    const store = brittleStore(1);
    const room = await Room.load('doc-1', store);
    room.applyOps([insert(1, 'a', 'H')]); // lost: the append throws
    await room.flush();

    expect(() => room.applyOps([remove(2, 'a', { lamport: 1, replica: 'a' })])).toThrow(
      RoomUnavailableError,
    );
    // Nothing was stored, so there is no log that begins with a delete for an
    // item no insert ever created — the exact state that made a real document
    // permanently unloadable.
    expect(await store.loadSince('doc-1', 0)).toEqual([]);
  });

  it('leaves a healthy room completely unaffected', async () => {
    const room = await Room.load('doc-1', createMemoryStore());
    expect(room.applyOps([insert(1, 'a', 'H')])).toEqual({ seq: 1, ops: [insert(1, 'a', 'H')] });
    await room.flush();
    expect(room.failed).toBe(false);
    expect(room.applyOps([insert(2, 'a', 'I')])).toEqual({ seq: 2, ops: [insert(2, 'a', 'I')] });
  });
});
