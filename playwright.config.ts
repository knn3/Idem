import { defineConfig } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const socketHealthURL =
  (process.env['NEXT_PUBLIC_WS_URL'] ?? 'ws://localhost:8787').replace(/^ws/, 'http') + '/health';

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
  // Every test depends on a setup project that proves the socket server on the
  // port is this run's — see `e2e/server-identity.setup.ts`.
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'e2e', testIgnore: /.*\.setup\.ts/, dependencies: ['setup'] },
  ],
  // Web and socket server are started and waited on *separately*. Starting them
  // with one `pnpm dev` and waiting only on the web port is what let a stale
  // socket server from an earlier run serve a whole suite unnoticed — see
  // `e2e/global-setup.ts`. `DATABASE_URL` has to be in the environment either
  // way: the server refuses to start without it, and these tests assert on
  // state that has to survive a reload.
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : [
        {
          command: 'pnpm dev:server',
          url: socketHealthURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: 'pnpm dev:web',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
