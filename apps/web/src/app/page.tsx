import type { Metadata } from 'next';

import { Landing } from './landing';
import { fontClassName } from './fonts';
import { JsonLd } from '../components/json-ld';
import { buildSiteJsonLd, SITE_KEYWORDS, siteUrl } from '../lib/seo';

/**
 * The public landing page.
 *
 * Fonts live in `./fonts` so the pricing, about and legal pages render in the
 * same editorial face; this file only owns the page's metadata and content.
 *
 * The keywords and the JSON-LD graph come from `lib/seo` so the tags, the copy
 * and the structured data stay the same story; the canonical URL keeps
 * mirrors of this page (`?ref=…`, www, a future custom domain) from fighting
 * over which one is the search result.
 */
export const metadata: Metadata = {
  title: 'RenderFlow — AI marketing studio and social scheduler',
  description:
    'Turn one brand brief into captions, posters, carousels and reels, then schedule the approved ones to Instagram and LinkedIn. Pay per asset, not per seat.',
  alternates: { canonical: '/' },
  keywords: [...SITE_KEYWORDS],
  openGraph: {
    title: 'RenderFlow — A month of marketing, made in an afternoon',
    description:
      'An AI marketing studio and social scheduler for small teams. Brief in, campaign out, scheduled with you in control.',
    type: 'website',
  },
};

export default function Home() {
  return (
    <>
      <JsonLd data={buildSiteJsonLd(siteUrl())} />
      <Landing fontClassName={fontClassName} />
    </>
  );
}
