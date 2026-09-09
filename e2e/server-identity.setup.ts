import { expect, test as setup } from '@playwright/test';

/**
 * Proves the socket server the tests are about to talk to is *this run's*
 * server, before a single test executes.
 *
 * This exists because of a real and expensive failure. `pnpm dev` starts the
 * web app and the socket server together, but Playwright only ever waited on
 * the web app's port. A socket server left running by an earlier session kept
 * `:8787`, the new one exited with `EADDRINUSE`, and the whole suite ran
 * against a stale process still pointing at a database that had since been
 * deleted — silently. The offline tests failed, the failures looked exactly
 * like a CRDT bug, and even checking out an older commit "reproduced" them,
 * because the checkout swapped the client while the stale server kept serving.
 *
 * Two ports answering is not the same as two ports answering *for you*.
 */

const SOCKET_HEALTH =
  process.env['E2E_SOCKET_HEALTH_URL'] ??
  (process.env['NEXT_PUBLIC_WS_URL'] ?? 'ws://localhost:8787').replace(/^ws/, 'http') + '/health';

/** The database name in a connection string, or null when there is nothing to compare against. */
function expectedDatabase(): string | null {
  const url = process.env['DATABASE_URL'];
  if (!url) return null;
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

setup('the socket server on this port belongs to this run', async ({ request }) => {
  const response = await request.get(SOCKET_HEALTH, { timeout: 30_000 });

  expect(
    response.ok(),
    `E_SOCKET_SERVER_UNHEALTHY: ${SOCKET_HEALTH} answered ${response.status()}. The socket ` +
      `server is up but its database is not. Check DATABASE_URL and that Postgres is running.`,
  ).toBe(true);

  const { database } = (await response.json()) as { database: string | null };
  const expected = expectedDatabase();
  // Only comparable when both ends know a name: a deployed target (E2E_BASE_URL
  // with no local DATABASE_URL) has nothing to check against, and that is fine.
  if (expected !== null && database !== null) {
    expect(
      database,
      `E_SOCKET_SERVER_MISMATCH: the server on ${SOCKET_HEALTH} is using database ` +
        `"${database}", but DATABASE_URL points at "${expected}". A server from an earlier ` +
        `run is probably still holding the port — stop it and try again ` +
        `(lsof -nP -iTCP:8787 -sTCP:LISTEN -t | xargs kill).`,
    ).toBe(expected);
  }
});
