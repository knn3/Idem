import { defineWorkspace } from 'vitest/config';

// Property and fuzz suites are slow and are split into their own project so
// `pnpm test:prop` can run them alone. `pnpm test` runs everything.
export default defineWorkspace([
  {
    test: {
      name: 'crdt',
      root: './packages/crdt',
      include: ['test/**/*.test.ts'],
      exclude: ['test/**/*.prop.test.ts'],
    },
  },
  {
    test: {
      name: 'crdt-prop',
      root: './packages/crdt',
      include: ['test/**/*.prop.test.ts'],
      testTimeout: 120_000,
    },
  },
  {
    test: {
      name: 'protocol',
      root: './packages/protocol',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'server',
      root: './apps/server',
      include: ['test/**/*.test.ts'],
    },
  },
]);
