import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from '../app/landing.module.css';

/**
 * The public surface: one header, one footer, one wrapper.
 *
 * Extracted from the landing page so the pricing, about and legal pages cannot
 * develop their own nav. The alternative - each page repeating a header - is how
 * a site ends up with a footer that links to a page it deleted.
 *
 * A server component: nothing here has state, and the only interactivity the site
 * needs is a link. `styles` is the landing page's module, reused rather than
 * duplicated so the editorial palette stays in one file (and one contrast test).
 */

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand}>
          <LogoMark />
          <span>RenderFlow</span>
        </Link>

        <nav className={styles.headerNav} aria-label="Primary">
          <Link className={styles.navLink} href="/#features">
            Features
          </Link>
          <Link className={styles.navLink} href="/pricing">
            Pricing
          </Link>
          <Link className={styles.navLink} href="/#how-it-works">
            How it works
          </Link>
          <Link className={styles.navLink} href="/about">
            About
          </Link>
        </nav>

        <div className={styles.headerActions}>
          <Link className={styles.signIn} href="/login">
            Sign in
          </Link>
          <Link className={styles.primaryCta} href="/register">
            Start free
            <ArrowRight className={styles.ctaArrow} />
          </Link>
        </div>
      </div>
    </header>
  );
}

/**
 * Footer links are the site map, in order of what someone deciding whether to
 * sign up actually wants: what it costs, what it is, what happens to their data.
 */
export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div>
          <Link href="/" className={styles.brand}>
            <LogoMark />
            <span>RenderFlow</span>
          </Link>
          <p className={styles.footerCopy}>
            An AI marketing studio and social scheduler for teams that would rather ship the
            campaign than chase the calendar.
          </p>
        </div>

        {/*
          Grouped, not one wrapping row of nine. Nine equal links wrapped 6 + 3
          at wide viewports, which read as a broken list rather than a site map.
        */}
        <nav className={styles.footerGroups} aria-label="Footer">
          <FooterGroup title="Product">
            <Link className={styles.footerLink} href="/#features">
              Features
            </Link>
            <Link className={styles.footerLink} href="/pricing">
              Pricing
            </Link>
            <Link className={styles.footerLink} href="/#how-it-works">
              How it works
            </Link>
            <Link className={styles.footerLink} href="/about">
              About
            </Link>
          </FooterGroup>

          <FooterGroup title="Trust & legal">
            <Link className={styles.footerLink} href="/security">
              Security
            </Link>
            <Link className={styles.footerLink} href="/terms">
              Terms
            </Link>
            <Link className={styles.footerLink} href="/privacy">
              Privacy
            </Link>
            <Link className={styles.footerLink} href="/contact">
              Contact
            </Link>
          </FooterGroup>

          <FooterGroup title="Account">
            <Link className={styles.footerLink} href="/login">
              Sign in
            </Link>
            <Link className={styles.footerLink} href="/register">
              Create account
            </Link>
          </FooterGroup>
        </nav>
      </div>

      <div className={styles.footerMeta}>
        <span>© {new Date().getFullYear()} RenderFlow</span>
        <span>Built for small teams with big calendars.</span>
      </div>
    </footer>
  );
}

/**
 * Wraps a public page.
 *
 * `main` carries `id="main"` because the root layout's skip link targets it on
 * every route - a marketing page without it would send keyboard users to the top
 * of the document instead of past the nav.
 */
export function MarketingPage({
  children,
  fontClassName,
}: {
  children: ReactNode;
  fontClassName?: string;
}) {
  const className = [styles.landing, fontClassName].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <MarketingHeader />
      <main id="main">{children}</main>
      <MarketingFooter />
    </div>
  );
}

function FooterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.footerNav}>
      <p className={styles.footerGroupTitle}>{title}</p>
      {children}
    </div>
  );
}

export function LogoMark() {
  return (
    <svg className={styles.brandMark} viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
      <rect x="3" y="4" width="14" height="5" rx="2.5" fill="#2563eb" />
      <rect x="9" y="11.5" width="16" height="5" rx="2.5" fill="#60a5fa" />
      <rect x="5" y="19" width="12" height="5" rx="2.5" fill="#ea580c" />
    </svg>
  );
}

export function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}
