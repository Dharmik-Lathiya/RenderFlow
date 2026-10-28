import type { Metadata } from 'next';

import { Landing } from './landing';
import { fontClassName } from './fonts';

/**
 * The public landing page.
 *
 * Fonts live in `./fonts` so the pricing, about and legal pages render in the
 * same editorial face; this file only owns the page's metadata and content.
 */
export const metadata: Metadata = {
  title: 'RenderFlow — AI marketing studio and social scheduler',
  description:
    'Turn one brand brief into captions, posters, carousels and reels, then schedule the approved ones. Pay per asset, not per seat, and get failed generations refunded.',
  openGraph: {
    title: 'RenderFlow — A month of marketing, made in an afternoon',
    description:
      'An AI marketing studio and social scheduler for small teams. Brief in, campaign out, scheduled with you in control.',
    type: 'website',
  },
};

export default function Home() {
  return <Landing fontClassName={fontClassName} />;
}
