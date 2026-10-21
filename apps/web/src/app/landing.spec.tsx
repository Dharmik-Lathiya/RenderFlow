import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';

import { Landing } from './landing';

/**
 * The landing page is mostly copy, which is exactly why it needs tests: copy is
 * where links rot, prices drift out of date, and an accessibility label quietly
 * disappears. No network, no router and no client state are involved.
 */
describe('landing page', () => {
  it('states the offer and has exactly one h1', () => {
    render(<Landing />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /a month of marketing\. made in an afternoon\./i,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('sends every primary and sign-in link to a real page', () => {
    render(<Landing />);

    const startLinks = screen.getAllByRole('link', { name: /start free/i });
    expect(startLinks.length).toBeGreaterThanOrEqual(3);
    for (const link of startLinks) {
      expect(link).toHaveAttribute('href', '/register');
    }

    const signInLinks = screen.getAllByRole('link', { name: /^sign in$/i });
    expect(signInLinks.length).toBeGreaterThan(0);
    for (const link of signInLinks) {
      expect(link).toHaveAttribute('href', '/login');
    }
  });

  it('points every in-page anchor at a section that exists', () => {
    const { container } = render(<Landing />);

    const anchors = [...container.querySelectorAll<HTMLAnchorElement>('a[href]')];
    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      expect(href).toMatch(/^(\/|#)/);

      if (href?.startsWith('#')) {
        expect(container.querySelector(href)).not.toBeNull();
      }
    }
  });

  it('describes the product preview instead of exposing decorative layers', () => {
    const { container } = render(<Landing />);

    expect(
      screen.getByRole('img', { name: /preview of the renderflow studio/i }),
    ).toBeInTheDocument();

    const mock = container.querySelector('[role="img"]');
    expect(mock?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('uses native details for the FAQ', () => {
    const { container } = render(<Landing />);

    const details = [...container.querySelectorAll('details')];
    expect(details.length).toBeGreaterThanOrEqual(4);

    for (const item of details) {
      const summary = item.querySelector('summary');
      expect(summary).not.toBeNull();
      expect(summary?.textContent?.trim().length).toBeGreaterThan(0);
      expect(item.open).toBe(false);
    }
  });

  it('does not print a hardcoded credit amount or price', () => {
    const { container } = render(<Landing />);
    const text = container.textContent ?? '';

    // The signup bonus and asset prices come from `SIGNUP_BONUS_CREDITS` and
    // `pricing_rules`. Marketing copy must not become a second source of truth.
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/\b\d+\s+credits?\b/i);
  });

  it('keeps the text token pairs at WCAG AA or better', () => {
    const css = readFileSync(path.join(__dirname, 'landing.module.css'), 'utf8');

    const token = (name: string): string => {
      const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      if (match?.[1] === undefined) {
        throw new Error(`landing.module.css is missing ${name}`);
      }
      return match[1];
    };

    expect(contrast(token('--lp-ink'), token('--lp-bg'))).toBeGreaterThanOrEqual(7);
    expect(contrast(token('--lp-muted'), token('--lp-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('--lp-blue'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--lp-orange-ink'), token('--lp-orange'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('--lp-navy'))).toBeGreaterThanOrEqual(4.5);
  });
});

function contrast(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 1) + 0.05) / ((darker ?? 0) + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/.{2}/g) ?? []).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
