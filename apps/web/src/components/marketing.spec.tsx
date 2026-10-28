import { readdirSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';

import { MarketingFooter, MarketingHeader, MarketingPage } from './marketing';

/**
 * The public nav, tested against the route table.
 *
 * This is the class of bug that motivated the file: the app had a "See plans"
 * button pointing at `/brands` and a footer with no pricing link at all, and
 * nothing failed. A link check turns "the marketing site has a dead end" into a
 * red test.
 */

const APP_DIR = path.join(__dirname, '..', 'app');

/**
 * Route table read from disk.
 *
 * Route groups - `(auth)/login/page.tsx` serving `/login` - mean the directory
 * name is not the URL, so the segments in parentheses are dropped when computing
 * a route rather than the check looking for a literal `app/login`.
 */
function routesOnDisk(): Set<string> {
  const routes = new Set<string>();

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'page.tsx') {
        routes.add(`/${segments.join('/')}`);
        continue;
      }
      if (!entry.isDirectory() || entry.name.startsWith('[')) {
        continue;
      }
      const visible = entry.name.startsWith('(') ? segments : [...segments, entry.name];
      walk(path.join(dir, entry.name), visible);
    }
  };

  walk(APP_DIR, []);
  return routes;
}

function internalLinks(): string[] {
  const { container } = render(
    <>
      <MarketingHeader />
      <MarketingFooter />
    </>,
  );

  const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('a[href]')].map(
    (anchor) => anchor.getAttribute('href') ?? '',
  );

  return [...new Set(hrefs.filter((href) => href.startsWith('/')))];
}

describe('marketing navigation', () => {
  it('links only to routes that exist', () => {
    const links = internalLinks();
    const routes = routesOnDisk();

    expect(links.length).toBeGreaterThan(5);

    for (const href of links) {
      // `/#features` is an anchor on the landing page, not a route of its own.
      const [route = ''] = href.split('#');
      expect(routes.has(route === '' ? '/' : route)).toBe(true);
    }
  });

  it('offers pricing as a real destination', () => {
    // The old dashboard CTA went to /brands, which could not tell a user what
    // anything cost.
    expect(internalLinks()).toContain('/pricing');
  });

  it('exposes the legal pages from the footer', () => {
    const links = internalLinks();
    for (const href of ['/terms', '/privacy', '/security', '/contact']) {
      expect(links).toContain(href);
    }
  });
});

describe('MarketingPage', () => {
  it('gives the skip link something to target', () => {
    // The root layout renders `href="#main"` on every page; a public page
    // without this id sends keyboard users to the top instead of past the nav.
    const { container } = render(<MarketingPage>content</MarketingPage>);
    expect(container.querySelector('main#main')).not.toBeNull();
  });

  it('renders one h1-worth of chrome and leaves headings to the page', () => {
    render(<MarketingPage>content</MarketingPage>);
    // The shared chrome must not compete with the page's own heading.
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
