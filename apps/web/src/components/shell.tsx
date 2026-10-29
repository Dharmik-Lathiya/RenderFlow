'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useApi } from '../lib/providers';
import { ThemeToggle } from './theme-toggle';
import { Badge } from './ui';
import styles from './ui.module.css';

/**
 * The application shell: nav, credit balance, sign out.
 *
 * A client component because all three of those need the browser. It renders
 * `children` untouched, so a server component page can still be a child of it -
 * the server/client split here is about what the SHELL needs, not about
 * banishing interactivity to a corner of the app.
 */
export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const pathname = usePathname();

  // Unauthenticated by definition: the public pages have no shell and no balance
  // to show. A list rather than three comparisons because the marketing site now
  // has more than one page, and a forgotten route here renders the app sidebar -
  // complete with "Signed out." - across a public page.
  const bare = isPublicPath(pathname);

  // `retry: false` so a signed-out visitor sees a link to sign in rather than an
  // error box on every page.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.me(),
    retry: false,
    enabled: !bare,
  });

  if (bare) {
    return <>{children}</>;
  }

  return (
    <div className="shell">
      <nav className={styles.nav} aria-label="Main">
        <p className={styles.navBrand}>
          <Link href="/" className={styles.navLink}>
            RenderFlow
          </Link>
        </p>

        <ul className={styles.navList}>
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles.navLink}
                // `aria-current` is what tells a screen reader where the user
                // is. Styling alone leaves that to be guessed.
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className={styles.navFooter}>
          <ThemeToggle />
          {me.isError ? (
            <>
              <p>Signed out.</p>
              <Link href="/login">Sign in</Link>
            </>
          ) : (
            me.data !== undefined && (
              <>
                <p className={styles.balance}>
                  <Badge tone={me.data.wallet.available === 0 ? 'warn' : 'good'}>
                    {me.data.wallet.available} credits
                  </Badge>
                </p>
                <button
                  type="button"
                  className={styles.navLink}
                  onClick={() => {
                    void api.auth.logout().finally(() => {
                      window.location.href = '/login';
                    });
                  }}
                >
                  Sign out
                </button>
              </>
            )
          )}
        </div>
      </nav>

      <main id="main" className="content">
        {children}
      </main>
    </div>
  );
}

/**
 * Routes that render without the app shell.
 *
 * Prefix-matched for the account-recovery screens so a token in the path (a
 * future `/reset-password/<token>`) stays bare too.
 */
const PUBLIC_PATHS = [
  '/',
  '/login',
  '/register',
  '/pricing',
  '/about',
  '/contact',
  '/security',
  '/terms',
  '/privacy',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
] as const;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

const NAV: { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/brands', label: 'Brands' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/settings/accounts', label: 'Accounts' },
  { href: '/admin', label: 'Admin' },
];

/** `/` must not light up for every path, or the nav says "you are here" always. */
function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}
