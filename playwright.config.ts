import { defineConfig } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // One document, one room: these tests share state by design, so they run
  // one at a time.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-failure',
  },
  // Starts web and server together unless they are already up. `DATABASE_URL`
  // has to be in the environment either way — the server refuses to start
  // without it, and these tests assert on state that has to survive a reload.
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : {
        command: 'pnpm dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
