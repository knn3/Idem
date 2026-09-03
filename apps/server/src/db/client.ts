import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { requireEnv } from '../env.js';
import * as schema from './schema.js';

export function createDb(connectionString = requireEnv('DATABASE_URL')) {
  const client = postgres(connectionString);
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDb>['db'];
