import type { MetadataRoute } from 'next';

/**
 * Crawler rules.
 *
 * The previous static `public/robots.txt` said `Disallow: /` for everyone, which
 * is served at the domain root and therefore blocked the landing page as well as
 * the app. A public marketing site that no crawler may index has no organic
 * acquisition at all.
 *
 * So: allow the marketing pages, disallow the signed-in application and the
 * credential screens. `/login` and `/register` are disallowed to keep search
 * results from offering a login form as the entry point.
 */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/dashboard',
          '/brands',
          '/campaigns',
          '/posts',
          '/calendar',
          '/analytics',
          '/notifications',
          '/settings',
          '/admin',
          '/login',
          '/register',
          '/api',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
