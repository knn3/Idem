import { describe, expect, it } from 'vitest';

import { createServer } from '../src/index.js';

/**
 * `/health` is what a test run, a deploy check, or a load balancer uses to
 * decide whether this process is worth talking to. An unconditional `ok` makes
 * it worse than useless: a server whose database has gone away still passes it,
 * so a health-gated run proceeds against a process that cannot persist a thing.
 * These tests pin the two answers that matter.
 */
describe('server', () => {
  it('reports which database answered, so a caller can tell whose server this is', async () => {
    const app = createServer({ probeDatabase: () => Promise.resolve('idem') });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, database: 'idem' });
    await app.close();
  });

  it('answers 503 when the database is unreachable, rather than claiming to be fine', async () => {
    const app = createServer({
      probeDatabase: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      database: null,
      code: 'E_DATABASE_UNREACHABLE',
    });
    // The message has to say what to do about it, not just what went wrong.
    expect((response.json() as { message: string }).message).toMatch(/DATABASE_URL/);
    await app.close();
  });

  it('stays healthy with no probe at all, for a server running on an in-memory store', async () => {
    const app = createServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, database: null });
    await app.close();
  });
});
