import type { MetadataRoute } from 'next';

/**
 * The public site map.
 *
 * Signed-in routes are absent on purpose: they are `Disallow`ed in `robots.ts`,
 * and a sitemap that advertises URLs a crawler may not fetch is a contradiction a
 * search console will report as an error.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const lastModified = new Date();

  return [
    { url: `${base}/`, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/pricing`, lastModified, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/about`, lastModified, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/security`, lastModified, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/contact`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${base}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
