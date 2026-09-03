import type { AddressInfo } from 'node:net';

import type { ServerMessage } from '@idem/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createServer } from '../src/index.js';
import { createMemoryStore } from '../src/store.js';

/**
 * Integration test for the day-12 checkpoint: real ws connections against a
 * real listening server, standing in for "two browser tabs edit the same
 * document and both stay in sync live" (PLAN.md M6).
 */

let app: ReturnType<typeof createServer> | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) ws.close();
  sockets.length = 0;
  if (app) {
    await app.close();
    app = null;
  }
});

async function startServer(): Promise<string> {
  app = createServer({ store: createMemoryStore() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Resolves `true` if no message arrives within the window — used to assert silence (dedup, dropped presence). */
function noMessageWithin(ws: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(true);
    }, ms);
    function onMessage() {
      clearTimeout(timer);
      resolve(false);
    }
    ws.once('message', onMessage);
  });
}

const insert = (lamport: number, replica: string, content: string) => ({
  kind: 'insert' as const,
  id: { lamport, replica },
  originLeft: null,
  content,
});

describe('WebSocket rooms (M6)', () => {
  it('two tabs on the same document converge: each op reaches both, including the sender', async () => {
    const url = await startServer();
    const a = await connect(url);
    const b = await connect(url);

    a.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 0 }));
    expect(await nextMessage(a)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 0 });

    b.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'b', sinceSeq: 0 }));
    expect(await nextMessage(b)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 0 });

    a.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H')] }));
    const [onA, onB] = await Promise.all([nextMessage(a), nextMessage(b)]);
    expect(onA).toEqual({ t: 'ops', ops: [insert(1, 'a', 'H')], seq: 1 });
    expect(onB).toEqual(onA);

    b.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'b', 'I')] }));
    const [onA2, onB2] = await Promise.all([nextMessage(a), nextMessage(b)]);
    expect(onA2).toEqual({ t: 'ops', ops: [insert(1, 'b', 'I')], seq: 2 });
    expect(onB2).toEqual(onA2);
  });

  it('a fresh connection catches up via hello sinceSeq with the in-memory tail', async () => {
    const url = await startServer();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 0 }));
    await nextMessage(a);
    a.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')] }));
    await nextMessage(a);

    const c = await connect(url);
    c.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'c', sinceSeq: 0 }));
    expect(await nextMessage(c)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(1, 'a', 'H'), insert(2, 'a', 'I')],
      seq: 2,
    });

    const d = await connect(url);
    d.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'd', sinceSeq: 1 }));
    expect(await nextMessage(d)).toEqual({
      t: 'welcome',
      snapshot: null,
      ops: [insert(2, 'a', 'I')],
      seq: 2,
    });
  });

  it('resending an already-applied op (reconnect resend) is deduplicated, not rebroadcast', async () => {
    const url = await startServer();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 0 }));
    await nextMessage(a);
    a.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H')] }));
    await nextMessage(a);

    // Simulates a reconnect resending its outbox from the same replica id.
    const again = await connect(url);
    again.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 1 }));
    expect(await nextMessage(again)).toEqual({ t: 'welcome', snapshot: null, ops: [], seq: 1 });

    again.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H')] }));
    expect(await noMessageWithin(again, 200)).toBe(true);
  });

  it('rejects a message sent before hello, without closing the connection', async () => {
    const url = await startServer();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'ops', ops: [insert(1, 'a', 'H')] }));
    expect(await nextMessage(a)).toEqual({
      t: 'error',
      code: 'hello-required',
      message: expect.any(String),
    });
    expect(a.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects a malformed message with a useful error, without closing the connection', async () => {
    const url = await startServer();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 0 }));
    await nextMessage(a);

    a.send(
      JSON.stringify({ t: 'ops', ops: [{ kind: 'insert', id: { lamport: 1, replica: 'a' } }] }),
    );
    const error = await nextMessage(a);
    expect(error.t).toBe('error');
    expect((error as { code: string }).code).toBe('invalid-client-message');
    expect((error as { message: string }).message.length).toBeGreaterThan(0);
    expect(a.readyState).toBe(WebSocket.OPEN);
  });

  it('a presence message is accepted but produces no broadcast (M10 scope)', async () => {
    const url = await startServer();
    const a = await connect(url);
    const b = await connect(url);
    a.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'a', sinceSeq: 0 }));
    await nextMessage(a);
    b.send(JSON.stringify({ t: 'hello', docId: 'doc-1', replica: 'b', sinceSeq: 0 }));
    await nextMessage(b);

    a.send(JSON.stringify({ t: 'presence', anchor: null, focus: { lamport: 1, replica: 'a' } }));
    expect(await noMessageWithin(a, 200)).toBe(true);
    expect(await noMessageWithin(b, 0)).toBe(true);
  });
});
