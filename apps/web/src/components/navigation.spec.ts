import { NAV_ITEMS, NAV_SECTIONS, currentNavItem, isActive } from './navigation';

/**
 * The navigation is data, but it is data both the sidebar and the command menu
 * trust. These tests keep the two surfaces in agreement: every section has a
 * destination, no route is listed twice, and "you are here" never leaks from a
 * nested path onto an unrelated one.
 */

describe('app navigation', () => {
  it('gives every declared section at least one destination', () => {
    for (const section of NAV_SECTIONS) {
      expect(NAV_ITEMS.some((item) => item.section === section)).toBe(true);
    }
  });

  it('lists each route once', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('keeps the root exact instead of matching every route', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/dashboard', '/')).toBe(false);
  });

  it('keeps a nested route active on its section', () => {
    expect(isActive('/brands', '/brands')).toBe(true);
    expect(isActive('/brands/acme', '/brands')).toBe(true);
    expect(isActive('/calendar', '/brands')).toBe(false);
  });

  it('finds the item for the current path', () => {
    expect(currentNavItem('/posts/123')).toBeUndefined();
    expect(currentNavItem('/settings/accounts')?.label).toBe('Accounts');
  });
});
