import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createHarness } from './ws-harness.js';

/**
 * Integration test for the day-12 checkpoint: real ws connections against a
 * real listening server, standing in for "two browser tabs edit the same
 * document and both stay in sync live" (PLAN.md M6).
 *
 * Since M10 a `hello` is answered by `welcome` *and* a presence roster, so
 * these tests consume the roster where one is expected. Presence itself is
 * covered in `presence.test.ts`.
 */

const harness = createHarness();
afterEach(() => harness.stop());

const insert = (lamport: number, replica: string, content: string) => ({
  kind: 'insert' as const,
  id: { lamport, replica },
  originLeft: null,
  content,
});

describe('WebSocket rooms (M6)', () => {
  it('two tabs on the same document converge: each op reaches both, including the sender', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    const b = await harness.join(url, 'b');
    await Promise.all([a.nextRoster(), b.nextRoster()]);

    a.send({ t: 'ops', ops: [insert(1, 'a', 'H')] });
    const [onA, onB] = await Promise.all([a.next(), b.next()]);
    expect(onA).toEqual({ t: 'ops', ops: [insert(1, 'a', 'H')], seq: 1 });
    expect(onB).toEqual(onA);

    b.send({ t: 'ops', ops: [insert(1, 'b', 'I')] });
    const [onA2, onB2] = await Promise.all([a.next(), b.next()]);
    expect(onA2).toEqual({ t: 'ops', ops: [insert(1, 'b', 'I')], seq: 2 });
    expect(onB2).toEqual(onA2);
  });

  it('a fresh connection catches up via hello sinceSeq with the in-memory tail', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    a.send({ t: 'ops', ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')] });
    await a.next();

    const c = await harness.connect(url);
    c.send({ t: 'hello', docId: 'doc-1', replica: 'c', sinceSeq: 0 });
    expect(await c.next()).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });

    const d = await harness.connect(url);
    d.send({ t: 'hello', docId: 'doc-1', replica: 'd', sinceSeq: 1 });
    expect(await d.next()).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(2, 'a', 'I')],
      seq: 2,
    });
  });

  it('resending an already-applied op (reconnect resend) is deduplicated, not rebroadcast', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();
    a.send({ t: 'ops', ops: [insert(1, 'a', 'H')] });
    await a.next();
    a.close();

    // Simulates a reconnect resending its outbox from the same replica id.
    const again = await harness.connect(url);
    again.send({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 1 });
    expect(await again.next()).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 1 });
    await again.nextRoster();

    again.send({ t: 'ops', ops: [insert(1, 'a', 'H')] });
    expect(await again.silentFor(200)).toBe(true);
  });

  it('rejects a message sent before hello, without closing the connection', async () => {
    const url = await harness.start();
    const a = await harness.connect(url);
    a.send({ t: 'ops', ops: [insert(1, 'a', 'H')] });
    expect(await a.next()).toEqual({
      t: 'error',
      code: 'hello-required',
      message: expect.any(String),
    });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects a malformed message with a useful error, without closing the connection', async () => {
    const url = await harness.start();
    const a = await harness.join(url, 'a');
    await a.nextRoster();

    a.send({ t: 'ops', ops: [{ kind: 'insert', id: { lamport: 1, replica: 'a' } }] });
    const error = await a.next();
    expect(error.t).toBe('error');
    expect((error as { code: string }).code).toBe('invalid-client-message');
    expect((error as { message: string }).message.length).toBeGreaterThan(0);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });
});
