/**
 * @idem/protocol — zod schemas for every wire message, both directions.
 *
 * Every WebSocket message is validated at the boundary. No `any`, no unchecked
 * casts across the wire (CLAUDE.md hard rule 9).
 *
 * Implemented in M5 (IDE-10), from SPEC §6.
 */

export type { OpId, Item, InsertOp, DeleteOp, Op } from './op.js';
export { opIdSchema, itemSchema, insertOpSchema, deleteOpSchema, opSchema } from './op.js';

export type {
  Snapshot,
  Peer,
  HelloMessage,
  ClientOpsMessage,
  ClientPresenceMessage,
  ClientMessage,
  WelcomeMessage,
  ServerOpsMessage,
  ServerPresenceMessage,
  ErrorMessage,
  ServerMessage,
} from './messages.js';
export {
  snapshotSchema,
  peerSchema,
  helloMessageSchema,
  clientOpsMessageSchema,
  clientPresenceMessageSchema,
  clientMessageSchema,
  welcomeMessageSchema,
  serverOpsMessageSchema,
  serverPresenceMessageSchema,
  errorMessageSchema,
  serverMessageSchema,
} from './messages.js';

export {
  ProtocolError,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
} from './parse.js';
