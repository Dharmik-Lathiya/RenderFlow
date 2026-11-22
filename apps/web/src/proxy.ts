import { NextResponse, type NextRequest } from 'next/server';

import { apiUpstreamOrigin } from './lib/api-rewrite';
import { buildContentSecurityPolicy } from './lib/csp';

/**
 * Content Security Policy with a per-request nonce (Next.js 16 `proxy.ts`).
 *
 * Next parses the nonce out of the CSP header and applies it to the framework
 * bundles and inline bootstrap scripts. Keeping the nonce in `proxy.ts` rather
 * than `next.config.ts` is what lets us avoid `'unsafe-inline'` on scripts.
 *
 * Tradeoff: nonce-based CSP requires dynamic rendering. The marketing pages lose
 * static optimisation but gain a real XSS mitigation. The app already renders
 * authenticated pages dynamically, so the blast radius is limited.
 */

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    apiOrigin: apiUpstreamOrigin(),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
