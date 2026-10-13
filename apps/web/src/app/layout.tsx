import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

import { Providers } from '../lib/providers';
import { Shell } from '../components/shell';

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
 * `lang` and the skip link are not decoration.
 *
 * A screen reader picks its voice from `lang`, and the skip link is the only way
 * a keyboard user gets past the nav on every page - which is one of the two
 * things the Phase 8 DoD asks for by name.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
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
