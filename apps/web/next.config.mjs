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
};

export default nextConfig;
