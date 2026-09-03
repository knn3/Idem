import type { Database } from './db/client.js';
import { appUser, document } from './db/schema.js';

/**
 * No auth or doc list exists until M11, but `document.owner_id` is a real
 * foreign key — op_log inserts fail without a document row to reference.
 * These fixed ids stand in for "the one demo document" until M11 replaces
 * them with real accounts and a doc list. The web client hardcodes the same
 * `DEV_DOC_ID` value (see apps/web/app/editor.tsx).
 */
export const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
export const DEV_DOC_ID = '00000000-0000-0000-0000-000000000002';

export async function ensureDevSeed(db: Database): Promise<void> {
  await db
    .insert(appUser)
    .values({ id: DEV_USER_ID, githubId: 'dev-seed', name: 'Dev' })
    .onConflictDoNothing();
  await db
    .insert(document)
    .values({ id: DEV_DOC_ID, ownerId: DEV_USER_ID, title: 'Demo', slug: 'demo' })
    .onConflictDoNothing();
}
