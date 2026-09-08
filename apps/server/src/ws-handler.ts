import {
  ProtocolError,
  parseClientMessage,
  serializeMessage,
  type ErrorMessage,
} from '@idem/protocol';
import type { RawData, WebSocket } from 'ws';

import type { Room, RoomRegistry } from './rooms.js';

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
  let joined: { room: Room; replica: string } | null = null;

  ws.on('message', (data: RawData) => {
    void (async () => {
      try {
        const message = parseClientMessage(data.toString());

        if (message.t === 'hello') {
          if (joined) {
            sendError(ws, 'already-joined', 'hello was already sent on this connection');
            return;
          }
          const room = await registry.getOrCreate(message.docId);
          joined = { room, replica: message.replica };
          room.join({ replica: message.replica, send: (raw) => ws.send(raw) });
          // `welcome` before the roster, always. A peer's anchors name items in
          // the document, so a client that saw presence first could be asked to
          // place a caret against a state it has not been sent yet.
          ws.send(serializeMessage(room.welcome(message.sinceSeq)));
          room.broadcastPresence();
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

        // 'presence' (M10): ephemeral, so it is recorded in the room and
        // rebroadcast, and never written to the store (SPEC §8). The roster
        // goes to everyone including the sender — one message shape for every
        // client beats a per-recipient filtered copy, and the client drops its
        // own entry when it renders.
        joined.room.setPresence(joined.replica, message.anchor, message.focus);
        joined.room.broadcastPresence();
      } catch (err) {
        if (err instanceof ProtocolError) {
          sendError(ws, err.code, err.message);
        } else {
          sendError(ws, 'internal-error', 'the server failed to process that message');
        }
      }
    })();
  });

  ws.on('close', () => {
    if (!joined) return;
    joined.room.leave(joined.replica);
    // Peers are dropped on disconnect (PLAN.md M10): the remaining clients are
    // told immediately rather than being left with a caret that will never move
    // again.
    joined.room.broadcastPresence();
  });
}
