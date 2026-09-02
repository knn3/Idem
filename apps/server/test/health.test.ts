import { describe, expect, it } from 'vitest';

import { createServer } from '../src/index.js';

describe('server', () => {
  it('answers /health', async () => {
    const app = createServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
