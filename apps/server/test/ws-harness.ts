import type { AddressInfo } from 'node:net';

import type { Peer, ServerMessage } from '@idem/protocol';
import { expect } from 'vitest';
import { WebSocket } from 'ws';

import { createServer } from '../src/index.js';
import { createMemoryStore } from '../src/store.js';

/**
 * A real listening server and real `ws` clients, for the integration tests.
 *
 * The reason this exists rather than an `ws.once('message')` per assertion:
 * an EventEmitter drops an event nobody is listening for, so two server
 * messages in the same tick lose the second. That is not hypothetical — a
 * `hello` is answered by `welcome` *and* a presence roster — so every socket
 * buffers from the moment it opens and reads pull from the buffer.
 */

export interface TestClient {
  readonly ws: WebSocket;
  /** The next message in arrival order, buffered or awaited. */
  next(): Promise<ServerMessage>;
  /** The next message, asserted to be a roster, sorted by replica so order is not under test. */
  nextRoster(): Promise<Peer[]>;
  /** Resolves `true` if nothing arrives within `ms` — for asserting silence. */
  silentFor(ms: number): Promise<boolean>;
  send(message: unknown): void;
  close(): void;
}

export interface Harness {
  /** Starts a server on an ephemeral port over a fresh in-memory store; returns its ws url. */
  start(): Promise<string>;
  connect(url: string): Promise<TestClient>;
  /** Connects, sends `hello`, and consumes the `welcome` that answers it. */
  join(
    url: string,
    replica: string,
    options?: { docId?: string; sinceSeq?: number },
  ): Promise<TestClient>;
  /** Closes every socket and the server. Call from `afterEach`. */
  stop(): Promise<void>;
}

export function createHarness(): Harness {
  let app: ReturnType<typeof createServer> | null = null;
  const clients: TestClient[] = [];

  function wrap(ws: WebSocket): TestClient {
    const buffered: ServerMessage[] = [];
    let waiting: ((message: ServerMessage) => void) | null = null;

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    });

    const client: TestClient = {
      ws,
      next() {
        const buffed = buffered.shift();
        if (buffed) return Promise.resolve(buffed);
        return new Promise<ServerMessage>((resolve) => {
          waiting = resolve;
        });
      },
      async nextRoster() {
        const message = await client.next();
        expect(message.t).toBe('presence');
        const { peers } = message as { peers: Peer[] };
        return [...peers].sort((a, b) => a.replica.localeCompare(b.replica));
      },
      silentFor(ms) {
        if (buffered.length > 0) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            waiting = null;
            resolve(true);
          }, ms);
          waiting = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
      },
      send(message) {
        ws.send(JSON.stringify(message));
      },
      close() {
        ws.close();
      },
    };
    clients.push(client);
    return client;
  }

  return {
    async start() {
      app = createServer({ store: createMemoryStore() });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      return `ws://127.0.0.1:${port}/ws`;
    },

    connect(url) {
      const ws = new WebSocket(url);
      const client = wrap(ws);
      return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(client));
        ws.once('error', reject);
      });
    },

    async join(url, replica, options = {}) {
      const client = await this.connect(url);
      client.send({
        t: 'hello',
        docId: options.docId ?? 'doc-1',
        replica,
        sinceSeq: options.sinceSeq ?? 0,
      });
      const welcome = await client.next();
      expect(welcome.t).toBe('welcome');
      return client;
    },

    async stop() {
      for (const client of clients) client.close();
      clients.length = 0;
      if (app) {
        await app.close();
        app = null;
      }
    },
  };
}
