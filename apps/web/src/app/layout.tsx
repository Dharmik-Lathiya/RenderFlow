import type { Metadata } from 'next';

import './globals.css';

/**
 * Root layout. AGENTS.md section 7 (Next.js): App Router, server components by
 * default. Interactivity is opted into per component as the dashboard is built
 * in Phase 8.
 */
export const metadata: Metadata = {
  title: 'RenderFlow',
  description: 'AI marketing studio and social scheduler',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
