import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not build output.
  transpilePackages: ['@idem/crdt', '@idem/protocol'],
  // Pin the trace root to this repo; other lockfiles above it are unrelated.
  outputFileTracingRoot: repoRoot,
  webpack: (config) => {
    // Workspace packages use NodeNext-style relative imports ("./id.js" for
    // a file that's actually id.ts) so `pnpm build`'s tsc output and Node's
    // own ESM resolution both work. Webpack doesn't do that extension
    // remapping by default — tell it to try .ts/.tsx before the literal .js.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
