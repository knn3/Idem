/**
 * Parse/serialize boundary for wire messages. Rejects malformed input with a
 * `ProtocolError` carrying a code and a zod-derived message describing what
 * was wrong (CLAUDE.md: "errors carry a code and a message that says what to
 * do about it").
 */
import type { z } from 'zod';
import {
  clientMessageSchema,
  type ClientMessage,
  serverMessageSchema,
  type ServerMessage,
} from './messages.js';

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function parseWith<T>(schema: z.ZodType<T>, code: string, raw: unknown): T {
  const json: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ProtocolError(
      code,
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return result.data;
}

/** Parses and validates a message coming from a client (a raw JSON string or already-parsed value). */
export function parseClientMessage(raw: unknown): ClientMessage {
  return parseWith(clientMessageSchema, 'invalid-client-message', raw);
}

/** Parses and validates a message coming from the server (a raw JSON string or already-parsed value). */
export function parseServerMessage(raw: unknown): ServerMessage {
  return parseWith(serverMessageSchema, 'invalid-server-message', raw);
}

export function serializeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
