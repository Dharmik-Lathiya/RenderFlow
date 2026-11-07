import type { NextConfig } from 'next';

/**
 * Where the browser-facing API calls actually go.
 *
 * The client defaults to the same-origin relative path `/api/v1` (see
 * `src/lib/api-url.ts`), so this rewrite is what makes those calls reach the
 * backend: in development `http://localhost:4000`, in production whatever
 * `API_INTERNAL_URL` (or `NEXT_PUBLIC_API_URL`) points at.
 *
 * `API_INTERNAL_URL` is read at runtime, not baked into the bundle, so the
 * backend can be repointed by setting an environment variable rather than
 * rebuilding the web app. Cookies stay first-party, which is also what the
 * `SameSite=Lax` auth cookie requires.
 */
function apiRewriteDestination(): string {
  const configured =
    process.env.API_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:4000/api/v1';
  return `${configured.replace(/\/+$/, '')}/:path*`;
}

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
