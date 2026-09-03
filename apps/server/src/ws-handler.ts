import {
  ProtocolError,
  parseClientMessage,
  serializeMessage,
  type ErrorMessage,
} from '@idem/protocol';
import type { RawData, WebSocket } from 'ws';

import type { RoomRegistry } from './rooms.js';

function sendError(ws: WebSocket, code: string, message: string): void {
  const payload: ErrorMessage = { t: 'error', code, message };
  ws.send(serializeMessage(payload));
}

/**
 * Wires one raw `ws` connection to the room registry. A connection joins a
 * room on its first `hello` and stays in it for its lifetime — `docId` and
 * `replica` are fixed for the socket, matching how a client owns one replica
 * id per session (SPEC §1).
 */
export function handleConnection(ws: WebSocket, registry: RoomRegistry): void {
  let joined: { room: ReturnType<RoomRegistry['getOrCreate']>; replica: string } | null = null;

  ws.on('message', (data: RawData) => {
    try {
      const message = parseClientMessage(data.toString());

      if (message.t === 'hello') {
        if (joined) {
          sendError(ws, 'already-joined', 'hello was already sent on this connection');
          return;
        }
        const room = registry.getOrCreate(message.docId);
        joined = { room, replica: message.replica };
        room.join({ replica: message.replica, send: (raw) => ws.send(raw) });
        ws.send(serializeMessage(room.welcome(message.sinceSeq)));
        return;
      }

      if (!joined) {
        sendError(ws, 'hello-required', 'send hello before ops or presence');
        return;
      }

      if (message.t === 'ops') {
        const result = joined.room.applyOps(message.ops);
        if (result)
          joined.room.broadcast(serializeMessage({ t: 'ops', ops: result.ops, seq: result.seq }));
        return;
      }

      // 'presence': the schema accepts it (SPEC §6) but broadcasting peers with
      // names and colors is M10 scope. Accepting and dropping it keeps this
      // connection forward-compatible without building presence early.
    } catch (err) {
      if (err instanceof ProtocolError) {
        sendError(ws, err.code, err.message);
      } else {
        sendError(ws, 'internal-error', 'the server failed to process that message');
      }
    }
  });

  ws.on('close', () => {
    if (joined) joined.room.leave(joined.replica);
  });
}
