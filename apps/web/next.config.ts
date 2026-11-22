import type { NextConfig } from 'next';

import { apiRewriteDestination } from './src/lib/api-rewrite';

/**
 * The browser calls the same-origin relative path `/api/v1` (see
 * `src/lib/api-url.ts`). This rewrite forwards it to an ABSOLUTE upstream:
 * `API_INTERNAL_URL` when set, otherwise the Render API in production and
 * localhost in development. A relative upstream would rewrite the request back
 * to itself and Next would render `/_not-found`.
 *
 * Next bakes rewrites into the build, so changing `API_INTERNAL_URL` requires a
 * new deployment. Cookies stay first-party, which the `SameSite=Lax` auth cookie
 * requires.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Explicit output for a small self-contained production image later (Phase 8).
  output: 'standalone',
  poweredByHeader: false,
  // Note: Next 16 removed the `eslint` config key. Linting is a separate CI step
  // (`pnpm lint`) rather than part of `next build`.
  headers() {
    return Promise.resolve([
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ]);
  },
  rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: apiRewriteDestination(),
      },
    ];
  },
};

export default nextConfig;
