import { Calistoga, Inter } from 'next/font/google';

/**
 * Marketing fonts, in one place.
 *
 * `next/font` must be called at module scope, so before the pricing/about pages
 * existed this lived inside `app/page.tsx` and only the landing page could use it.
 * Both faces are self-hosted by `next/font`, with a metric-adjusted fallback, so
 * first paint never waits on Google.
 */
export const display = Calistoga({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-landing-display',
  display: 'swap',
});

export const body = Inter({
  subsets: ['latin'],
  variable: '--font-landing-body',
  display: 'swap',
});

/** Both variables, for `MarketingPage`'s wrapper. */
export const fontClassName = `${display.variable} ${body.variable}`;
