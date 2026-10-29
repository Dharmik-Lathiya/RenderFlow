import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

import { Providers } from '../lib/providers';
import { Shell } from '../components/shell';
import { THEME_STORAGE_KEY } from '../lib/theme-config';

/**
 * Root layout.
 *
 * `Providers` is a client component because react-query and the API context both
 * need the browser. Keeping it as the only client boundary here means the rest of
 * the tree can stay server components where there is nothing interactive to do.
 */
export const metadata: Metadata = {
  title: 'RenderFlow',
  description: 'AI marketing studio and social scheduler',
};

/**
 * Runs before the first paint, so a reload with a stored light preference never
 * flashes the dark default. Kept inline rather than in a client component: a
 * React effect runs after paint, which is exactly one frame too late.
 */
const THEME_BOOT_SCRIPT = `(function () {
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  }
})();`;

/**
 * `lang` and the skip link are not decoration.
 *
 * A screen reader picks its voice from `lang`, and the skip link is the only way
 * a keyboard user gets past the nav on every page - which is one of the two
 * things the Phase 8 DoD asks for by name.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // The boot script adds `data-theme` before hydration; React must not treat
    // that deliberate attribute as a mismatch.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/*
          A native blocking script, deliberately not `next/script`: the
          `beforeInteractive` strategy queues the code for Next's runtime, which
          is late enough to paint the wrong theme for a frame. As the first node
          in the body it runs before any app markup is parsed.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
