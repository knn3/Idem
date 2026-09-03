/**
 * Drizzle schema — documents, op_log and snapshots, per SPEC §9.
 *
 * op_log is append-only. Every operation is written inside the same
 * transaction that assigns its `seq` (see rooms.ts), and the unique
 * constraint on (doc_id, replica, lamport) is the backstop that makes
 * duplicate delivery impossible at the database level even if the
 * in-memory dedup were ever bypassed.
 *
 * Defined in M7 (IDE-12). `snapshot` is unused until M8 — it's declared now
 * because SPEC §9 defines the whole schema together, but nothing reads or
 * writes it yet.
 */
import type { Item, Op } from '@idem/protocol';
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey(),
  githubId: text('github_id').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
});

export const document = pgTable('document', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => appUser.id),
  title: text('title').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const opLog = pgTable(
  'op_log',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => document.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    replica: text('replica').notNull(),
    lamport: integer('lamport').notNull(),
    op: jsonb('op').$type<Op>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.seq] }), unique().on(t.docId, t.replica, t.lamport)],
);

export const snapshot = pgTable(
  'snapshot',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => document.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    items: jsonb('items').$type<Item[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.seq] })],
);
