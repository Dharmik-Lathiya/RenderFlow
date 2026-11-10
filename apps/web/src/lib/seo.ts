/**
 * The public site's SEO strings and URLs, in one place.
 *
 * Titles and descriptions drift three ways at once: the page copy, the meta
 * tags and the structured data. Growing brand signals (Search Console)
 * depend on the same phrases appearing in all three, so the keyword set, the
 * base URL and the JSON-LD graph are constants here, and the pages compose
 * from them rather than restating them.
 */

/**
 * The public base URL.
 *
 * `NEXT_PUBLIC_SITE_URL` is the source of truth - the same value feeds
 * `sitemap.ts` and `robots.ts`. The production fallback keeps canonical URLs
 * and Open Graph tags absolute when the variable has not been set for a fresh
 * deployment (a `<meta property="og:url">` pointing at `localhost` is how a
 * site ends up shared with broken previews), while local dev keeps working
 * without configuration.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      // Normalise to the origin: a configured value with a path or trailing
      // slashes must not leak into canonicals, sitemaps or Open Graph URLs.
      return new URL(configured).origin;
    } catch {
      // A malformed variable must not crash every route; fall through to the
      // environment default below.
    }
  }
  return process.env.NODE_ENV === 'production'
    ? 'https://renderflowapp.vercel.app'
    : 'http://localhost:3000';
}

/**
 * The keyword set this site competes for, brand term first.
 *
 * Every phrase maps to copy that already exists on the landing page
 * (captions, posters, carousels, reels, Instagram, LinkedIn, credit
 * pricing), so the tags reinforce the content instead of stuffing it. The
 * `keywords` meta tag itself is a weak signal - Google has ignored it for
 * years - so this list is also woven into the JSON-LD graph and the
 * descriptions, which search engines actually read.
 */
export const SITE_KEYWORDS = [
  'RenderFlow',
  'AI marketing studio',
  'AI social media scheduler',
  'AI captions',
  'Instagram captions',
  'AI posters',
  'AI carousels',
  'AI reels',
  'LinkedIn posts',
  'social media calendar',
  'schedule Instagram posts',
] as const;

/** The site-wide description: what it is, in one sentence, keywords included. */
export const SITE_DESCRIPTION =
  'AI marketing studio and social media scheduler: captions, posters, carousels and reels from one brand brief, scheduled to Instagram and LinkedIn.';

/**
 * The structured data graph for the landing page.
 *
 * Three entities, cross-referenced by `@id` so search engines read them as one
 * thing: the organization (brand identity), its website, and the product,
 * with the free-credit offer stated without a number - the amount comes from
 * `SIGNUP_BONUS_CREDITS` in the API, and marketing copy must not duplicate a
 * business constant it cannot keep in sync.
 *
 * No ratings or awards: Schema.org claims that this repository cannot prove
 * are exactly the kind of structured data Google discounts.
 */
export function buildSiteJsonLd(baseUrl: string): Record<string, unknown> {
  const organization = `${baseUrl}/#organization`;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organization,
        name: 'RenderFlow',
        alternateName: 'RenderFlow App',
        url: baseUrl,
        logo: `${baseUrl}/icon.svg`,
        // The public repository is the one profile this project can point at
        // without inventing a social account; it disambiguates the brand name
        // from unrelated products that share it.
        sameAs: ['https://github.com/Dharmik-Lathiya/RenderFlow'],
        description: 'AI marketing studio and social media scheduler for small teams.',
      },
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        name: 'RenderFlow',
        alternateName: 'RenderFlow App',
        url: baseUrl,
        publisher: { '@id': organization },
        inLanguage: 'en',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${baseUrl}/#product`,
        name: 'RenderFlow',
        url: baseUrl,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description:
          'Generate captions, posters, carousels and reels from one brand brief, then schedule the approved ones.',
        publisher: { '@id': organization },
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free credits to start; pay per generated asset, not per seat.',
        },
        keywords: SITE_KEYWORDS.join(', '),
      },
    ],
  };
}
