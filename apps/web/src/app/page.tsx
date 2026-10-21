import type { Metadata } from 'next';
import { Calistoga, Inter } from 'next/font/google';

import { Landing } from './landing';

/**
 * The public landing page.
 *
 * Fonts are loaded here rather than in the root layout: the application shell
 * uses the platform UI font, and the marketing page is the one place that needs
 * an editorial display face. `next/font` self-hosts both files and emits a
 * metric-adjusted fallback, so the first paint does not wait on Google.
 */
const display = Calistoga({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-landing-display',
  display: 'swap',
});

const body = Inter({
  subsets: ['latin'],
  variable: '--font-landing-body',
  display: 'swap',
});

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
  return <Landing fontClassName={`${display.variable} ${body.variable}`} />;
}
