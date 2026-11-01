import type { IconName } from './icons';

/**
 * The app navigation, shared by the sidebar and the command menu.
 *
 * Kept out of either component so "where can I go?" has one answer. A link
 * added here appears in both surfaces, which is the point.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  section: 'Workspace' | 'Manage';
  description: string;
  /** Extra words the command menu should match, without showing them. */
  keywords?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: 'dashboard',
    section: 'Workspace',
    description: 'Credits, brands and what needs attention',
    keywords: 'home overview',
  },
  {
    href: '/brands',
    label: 'Brands',
    icon: 'brands',
    section: 'Workspace',
    description: 'Voices, campaigns and brand settings',
    keywords: 'workspace voice campaigns',
  },
  {
    href: '/calendar',
    label: 'Calendar',
    icon: 'calendar',
    section: 'Workspace',
    description: 'Scheduled posts by day',
    keywords: 'schedule queue publishing',
  },
  {
    href: '/analytics',
    label: 'Analytics',
    icon: 'analytics',
    section: 'Workspace',
    description: 'Reach, engagement and campaign performance',
    keywords: 'insights metrics reports',
  },
  {
    href: '/notifications',
    label: 'Notifications',
    icon: 'notifications',
    section: 'Manage',
    description: 'Publish failures, refunds and account alerts',
    keywords: 'alerts inbox activity',
  },
  {
    href: '/settings/accounts',
    label: 'Accounts',
    icon: 'accounts',
    section: 'Manage',
    description: 'Connected social channels',
    keywords: 'social linkedin instagram connections',
  },
  {
    href: '/admin',
    label: 'Admin',
    icon: 'admin',
    section: 'Manage',
    description: 'Dead-letter queue, reconciliation and credits',
    keywords: 'operator console dlq outbox',
  },
];

export const NAV_SECTIONS = ['Workspace', 'Manage'] as const;

/** `/` must not light up for every path, or the nav says "you are here" always. */
export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function currentNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => isActive(pathname, item.href));
}
