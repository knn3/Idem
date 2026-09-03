/**
 * Schemas mirroring the CRDT's own types (SPEC §1–§2). Kept independent of
 * `@idem/crdt` — protocol validates the *wire* shape, and zod's inferred
 * types are structurally identical to the crdt package's, so callers can
 * pass either where the other is expected.
 */
import { z } from 'zod';

export const opIdSchema = z.object({
  lamport: z.number().int().nonnegative(),
  replica: z.string().min(1),
});
export type OpId = z.infer<typeof opIdSchema>;

export const itemSchema = z.object({
  id: opIdSchema,
  originLeft: opIdSchema.nullable(),
  content: z.string().length(1),
  deleted: z.boolean(),
});
export type Item = z.infer<typeof itemSchema>;

export const insertOpSchema = z.object({
  kind: z.literal('insert'),
  id: opIdSchema,
  originLeft: opIdSchema.nullable(),
  content: z.string().length(1),
});
export type InsertOp = z.infer<typeof insertOpSchema>;

export const deleteOpSchema = z.object({
  kind: z.literal('delete'),
  id: opIdSchema,
  target: opIdSchema,
});
export type DeleteOp = z.infer<typeof deleteOpSchema>;

export const opSchema = z.discriminatedUnion('kind', [insertOpSchema, deleteOpSchema]);
export type Op = z.infer<typeof opSchema>;
