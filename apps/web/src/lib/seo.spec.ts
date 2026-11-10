import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildSiteJsonLd, SITE_DESCRIPTION, SITE_KEYWORDS, siteUrl } from './seo';

/**
 * The SEO strings are only useful if the pages they describe actually contain
 * the phrases: a keyword set that has drifted away from the copy is a tag
 * nobody reads. So this spec both checks the builders and reads the sources
 * the way `globals.spec.ts` reads the stylesheet.
 */
describe('SEO strings and structured data', () => {
  describe('siteUrl', () => {
    const ENV = process.env;
    const setNodeEnv = (value: string | undefined): void => {
      // `NODE_ENV` is typed read-only, but Node itself allows the switch, and
      // the two branches of `siteUrl` differ exactly on it.
      (process.env as { NODE_ENV?: string | undefined }).NODE_ENV = value;
    };

    beforeEach(() => {
      process.env = { ...ENV };
      delete process.env.NEXT_PUBLIC_SITE_URL;
    });

    afterEach(() => {
      process.env = ENV;
    });

    it('uses the configured public URL and normalises it to its origin', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://renderflowapp.com/pathless///';

      expect(siteUrl()).toBe('https://renderflowapp.com');
    });

    it('ignores a configured value that is not a URL', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'not a url';
      setNodeEnv('production');

      expect(siteUrl()).toBe('https://renderflowapp.vercel.app');
    });

    it('falls back to the deployed URL in production so tags stay absolute', () => {
      setNodeEnv('production');

      expect(siteUrl()).toBe('https://renderflowapp.vercel.app');
    });

    it('stays on localhost outside production', () => {
      setNodeEnv('development');

      expect(siteUrl()).toBe('http://localhost:3000');
    });
  });

  describe('buildSiteJsonLd', () => {
    const jsonLd = buildSiteJsonLd('https://renderflowapp.vercel.app');

    const node = (type: string): Record<string, unknown> => {
      const entries = jsonLd['@graph'] as Array<Record<string, unknown>>;
      const found = entries.find((entry) => entry['@type'] === type);
      if (!found) {
        throw new Error(`${type} is missing from the graph`);
      }
      return found;
    };

    it('declares one graph of organization, website and product', () => {
      const entries = jsonLd['@graph'] as Array<Record<string, unknown>>;

      expect(jsonLd['@context']).toBe('https://schema.org');
      expect(entries.map((entry) => entry['@type'])).toEqual([
        'Organization',
        'WebSite',
        'SoftwareApplication',
      ]);
      expect(entries.every((entry) => typeof entry['@id'] === 'string')).toBe(true);
    });

    it('cross-references the entities instead of duplicating them', () => {
      const organizationId = 'https://renderflowapp.vercel.app/#organization';

      expect(node('Organization')['@id']).toBe(organizationId);
      expect((node('WebSite').publisher as Record<string, unknown>)['@id']).toBe(organizationId);
      expect((node('SoftwareApplication').publisher as Record<string, unknown>)['@id']).toBe(
        organizationId,
      );
    });

    it('names the product attributes a branded search reads as one entity', () => {
      expect(node('Organization')).toMatchObject({
        name: 'RenderFlow',
        url: 'https://renderflowapp.vercel.app',
        logo: 'https://renderflowapp.vercel.app/icon.svg',
      });
    });

    it('states the offer without inventing ratings or a credit number', () => {
      const product = JSON.stringify(node('SoftwareApplication'));

      expect(product).toContain('"price":"0"');
      expect(JSON.stringify(jsonLd['@graph'])).not.toMatch(/aggregateRating|award|review/);
      expect(JSON.stringify(jsonLd)).not.toContain('50');
    });
  });

  describe('wiring', () => {
    const readSrc = (...parts: string[]): string =>
      readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

    it('roots the metadata on the public base URL', () => {
      const layout = readSrc('app', 'layout.tsx');

      expect(layout).toContain('metadataBase: new URL(siteUrl())');
      expect(layout).toContain('verification: {\n    google:');
    });

    it('emits the JSON-LD graph on the landing page and canonicalises /', () => {
      const page = readSrc('app', 'page.tsx');

      expect(page).toContain('<JsonLd');
      expect(page).toContain("canonical: '/'");
      expect(page).toContain('SITE_KEYWORDS');
    });

    it('keeps every canonical pointing at a real marketing route', () => {
      for (const route of ['pricing', 'about', 'contact', 'security', 'terms', 'privacy']) {
        expect(readSrc('app', route, 'page.tsx')).toContain(`canonical: '/${route}'`);
      }
    });

    it('keeps every keyword backed by copy a crawler can read', () => {
      // No keyword may exist only in this module's constants: the landing copy
      // and the description must carry every word, or the tag is stuffing.
      const source = `${readSrc('app', 'page.tsx')} ${readSrc('app', 'landing.tsx')} ${
        SITE_DESCRIPTION
      }`.toLowerCase();

      const dropped = SITE_KEYWORDS.filter((keyword) => {
        // The brand term lives in the wordmark; every other phrase is prose.
        const words = keyword === 'RenderFlow' ? [keyword] : keyword.split(' ');
        return !words.every((word) => source.includes(word.toLowerCase()));
      });

      expect(dropped).toEqual([]);
    });
  });
});
