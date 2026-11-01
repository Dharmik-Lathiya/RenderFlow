'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useApi } from '../lib/providers';
import { AccountMenu } from './account-menu';
import { CommandMenu } from './command-menu';
import { Icon } from './icons';
import { NAV_ITEMS, NAV_SECTIONS, currentNavItem } from './navigation';
import { ThemeToggle } from './theme-toggle';
import styles from './shell.module.css';

/**
 * The application shell.
 *
 * Three layers, each with one job:
 *
 *  - the sidebar carries workspace context, primary navigation and the things
 *    that belong to the account (credits, appearance, sign out);
 *  - the top bar carries global actions (search, notifications, account);
 *  - the mobile strip keeps every destination visible instead of hiding the nav
 *    behind a control a keyboard user cannot reach.
 *
 * A client component because all of those need the browser. It renders
 * `children` untouched, so server pages stay server pages.
 */
export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);

  // Unauthenticated by definition: the public pages have no shell and no balance
  // to show. A list rather than three comparisons because the marketing site now
  // has more than one page, and a forgotten route here renders the app sidebar -
  // complete with "Signed out." - across a public page.
  const bare = isPublicPath(pathname);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.me(),
    retry: false,
    enabled: !bare,
  });

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    retry: false,
    enabled: !bare && me.isSuccess,
  });

  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.notifications.unreadCount(),
    retry: false,
    enabled: !bare && me.isSuccess,
    refetchInterval: 60_000,
  });

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (bare) {
    return <>{children}</>;
  }

  const workspace = workspaces.data?.[0];
  const current = currentNavItem(pathname);
  const pageLabel = current?.label ?? 'Workspace';
  const user = me.data?.user;
  const wallet = me.data?.wallet;
  const unreadCount = unread.data ?? 0;
  const initials = initialsOf(user?.name ?? user?.email ?? 'RenderFlow');
  const workspaceInitial = initialsOf(workspace?.name ?? 'Workspace');

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar} aria-label="Sidebar">
        <div className={styles.sidebarTop}>
          <Link href="/dashboard" className={styles.brand}>
            <span className={styles.brandMark}>
              <Icon name="sparkles" />
            </span>
            <span className={styles.brandWord}>RenderFlow</span>
          </Link>
        </div>

        <div className={styles.workspaceCard} role="group" aria-label="Current workspace">
          <span className={styles.workspaceAvatar}>{workspaceInitial}</span>
          <span className={styles.workspaceInfo}>
            <span className={styles.workspaceName}>{workspace?.name ?? 'Your workspace'}</span>
            <span className={styles.workspaceRole}>{workspace?.role ?? 'Loading'}</span>
          </span>
          <Icon name="chevronDown" size={14} className={styles.workspaceChevron} />
        </div>

        <nav className={styles.sidebarNav} aria-label="Main">
          {NAV_SECTIONS.map((section) => (
            <div key={section} className={styles.navSection}>
              <p className={styles.navSectionTitle}>{section}</p>
              <ul className={styles.navList}>
                {NAV_ITEMS.filter((item) => item.section === section).map((item) => {
                  const active = current?.href === item.href;
                  const badge =
                    item.href === '/notifications' && unreadCount > 0 ? unreadCount : undefined;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                        // `aria-current` is what tells a screen reader where the
                        // user is. Styling alone leaves that to be guessed.
                        aria-current={active ? 'page' : undefined}
                      >
                        <Icon name={item.icon} size={17} className={styles.navIcon} />
                        <span className={styles.navLabel}>{item.label}</span>
                        {badge !== undefined && (
                          <span className={styles.navBadge} aria-hidden="true">
                            {badge > 99 ? '99+' : badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className={styles.sidebarSpacer} />

        {wallet !== undefined && (
          <div className={styles.creditCard}>
            <div className={styles.creditTop}>
              <span className={styles.creditIcon}>
                <Icon name="credits" size={13} />
              </span>
              <span>Credit balance</span>
              <Link href="/pricing" className={styles.creditLink}>
                Get more
              </Link>
            </div>
            <p className={`${styles.creditValue} ${wallet.available < 10 ? styles.creditLow : ''}`}>
              {wallet.available} credits
            </p>
            <p className={styles.creditHint}>{wallet.reserved} reserved by running work</p>
          </div>
        )}

        <div className={styles.sidebarFooter}>
          <ThemeToggle />

          {me.isError || user === undefined ? (
            <div className={styles.userCard}>
              <span className={styles.userAvatar}>?</span>
              <span className={styles.userInfo}>
                <span className={styles.userName}>Signed out</span>
                <span className={styles.userEmail}>No active session</span>
              </span>
              <Link href="/login" className={styles.creditLink}>
                Sign in
              </Link>
            </div>
          ) : (
            <>
              <div className={styles.userCard}>
                <span className={styles.userAvatar}>{initials}</span>
                <span className={styles.userInfo}>
                  <span className={styles.userName}>{user.name}</span>
                  <span className={styles.userEmail}>{user.email}</span>
                </span>
              </div>
              <button
                type="button"
                className={styles.signOutButton}
                onClick={() => {
                  void api.auth.logout().finally(() => {
                    window.location.href = '/login';
                  });
                }}
              >
                <Icon name="signOut" size={15} />
                Sign out
              </button>
            </>
          )}
        </div>
      </aside>

      <div className={styles.appMain}>
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <Link href="/dashboard" className={styles.mobileBrand}>
              <span className={styles.brandMark}>
                <Icon name="sparkles" size={16} />
              </span>
              RenderFlow
            </Link>
            <nav className={styles.breadcrumb} aria-label="Breadcrumb">
              <Link href="/dashboard" className={styles.breadcrumbLink}>
                {workspace?.name ?? 'Workspace'}
              </Link>
              <Icon name="chevronRight" size={13} className={styles.breadcrumbChevron} />
              <span className={styles.breadcrumbCurrent} aria-current="page">
                {pageLabel}
              </span>
            </nav>
          </div>

          <div className={styles.topbarActions}>
            <button
              type="button"
              className={styles.searchButton}
              onClick={() => setSearchOpen(true)}
              aria-label="Search RenderFlow"
            >
              <Icon name="search" size={16} />
              <span className={styles.searchLabel}>Search</span>
              <kbd className={styles.kbd}>⌘K</kbd>
            </button>

            <Link
              href="/notifications"
              className={styles.iconButton}
              aria-label={
                unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
              }
            >
              <Icon name="notifications" size={18} />
              {unreadCount > 0 && (
                <span className={styles.notificationBadge} aria-hidden="true">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Link>

            <Link href="/brands/new" className={styles.topbarCta}>
              <Icon name="plus" size={15} />
              New brand
            </Link>

            {user === undefined ? (
              <Link href="/login" className={styles.topbarAvatar} aria-label="Sign in">
                ?
              </Link>
            ) : (
              <AccountMenu
                user={user}
                wallet={wallet}
                initials={initials}
                onSignOut={() => {
                  void api.auth.logout().finally(() => {
                    window.location.href = '/login';
                  });
                }}
              />
            )}
          </div>
        </header>

        <nav className={styles.mobileNav} aria-label="Main">
          {NAV_ITEMS.map((item) => {
            const active = current?.href === item.href;
            const badge =
              item.href === '/notifications' && unreadCount > 0 ? unreadCount : undefined;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.mobileNavItem} ${active ? styles.mobileNavItemActive : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon name={item.icon} size={15} className={styles.mobileNavIcon} />
                {item.label}
                {badge !== undefined && (
                  <span className={styles.navBadge} aria-hidden="true">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <main id="main" className={styles.content}>
          {children}
        </main>
      </div>

      <CommandMenu open={searchOpen} onClose={closeSearch} />
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

function initialsOf(value: string): string {
  const words = value
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter((word) => word !== '');

  if (words.length === 0) {
    return 'R';
  }

  const first = words[0]?.[0] ?? 'R';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';

  return `${first}${last}`.toUpperCase();
}
