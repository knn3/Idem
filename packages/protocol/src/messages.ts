/**
 * Wire message schemas, SPEC §6. Every message crossing the WebSocket is
 * validated with these on both ends (CLAUDE.md hard rule 9) — no `any`, no
 * unchecked casts.
 */
import { z } from 'zod';
import { opIdSchema, itemSchema, opSchema } from './op.js';

export const snapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  items: z.array(itemSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const peerSchema = z.object({
  replica: z.string().min(1),
  name: z.string(),
  color: z.string(),
  anchor: opIdSchema.nullable(),
  focus: opIdSchema.nullable(),
});
export type Peer = z.infer<typeof peerSchema>;

// --- Client → server -------------------------------------------------------

export const helloMessageSchema = z.object({
  t: z.literal('hello'),
  docId: z.string().min(1),
  replica: z.string().min(1),
  sinceSeq: z.number().int().nonnegative(),
});
export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const clientOpsMessageSchema = z.object({
  t: z.literal('ops'),
  ops: z.array(opSchema),
});
export type ClientOpsMessage = z.infer<typeof clientOpsMessageSchema>;

export const clientPresenceMessageSchema = z.object({
  t: z.literal('presence'),
  anchor: opIdSchema.nullable(),
  focus: opIdSchema.nullable(),
});
export type ClientPresenceMessage = z.infer<typeof clientPresenceMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion('t', [
  helloMessageSchema,
  clientOpsMessageSchema,
  clientPresenceMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// --- Server → client ---------------------------------------------------------

export const welcomeMessageSchema = z.object({
  t: z.literal('welcome'),
  snapshot: snapshotSchema.nullable(),
  ops: z.array(opSchema),
  seq: z.number().int().nonnegative(),
});
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;

export const serverOpsMessageSchema = z.object({
  t: z.literal('ops'),
  ops: z.array(opSchema),
  seq: z.number().int().nonnegative(),
});
export type ServerOpsMessage = z.infer<typeof serverOpsMessageSchema>;

export const serverPresenceMessageSchema = z.object({
  t: z.literal('presence'),
  peers: z.array(peerSchema),
});
export type ServerPresenceMessage = z.infer<typeof serverPresenceMessageSchema>;

export const errorMessageSchema = z.object({
  t: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('t', [
  welcomeMessageSchema,
  serverOpsMessageSchema,
  serverPresenceMessageSchema,
  errorMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
