import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Explicit output for a small self-contained production image later (Phase 8).
  output: 'standalone',
  poweredByHeader: false,
  // Note: Next 16 removed the `eslint` config key. Linting is a separate CI step
  // (`pnpm lint`) rather than part of `next build`.
};

export default nextConfig;
