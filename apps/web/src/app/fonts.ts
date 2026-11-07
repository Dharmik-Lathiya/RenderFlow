import { Bricolage_Grotesque, Geist, Geist_Mono } from 'next/font/google';

/**
 * Fonts, in one place, matching `DESIGN.md` section 3.
 *
 * `next/font` must be called at module scope, so before the pricing/about pages
 * existed this lived inside `app/page.tsx` and only the landing page could use it.
 * All three faces are self-hosted by `next/font`, with a metric-adjusted fallback,
 * so first paint never waits on Google.
 *
 * The display face is only loaded on public marketing pages; the app shell keeps
 * the UI face throughout. `Geist Mono` is used for credit amounts, IDs and ledger
 * rows, where proportional figures would make columns jump.
 */
export const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const body = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});

export const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

/** App-wide variables: UI + mono. Display stays on marketing routes. */
export const appFontClassName = `${body.variable} ${mono.variable}`;

/** Marketing wrapper variables: display + UI + mono. */
export const fontClassName = `${display.variable} ${body.variable} ${mono.variable}`;
