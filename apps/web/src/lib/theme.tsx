'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from './theme-config';

export type { ResolvedTheme, ThemePreference } from './theme-config';
export { THEME_STORAGE_KEY } from './theme-config';

interface ThemeContextValue {
  /** What the user chose. `system` follows the OS and is the default. */
  theme: ThemePreference;
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  /** Flips to the opposite explicit theme. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Theme source of truth.
 *
 * The HTML element carries `data-theme="light" | "dark"`, and `globals.css`
 * maps that to tokens. The inline script in the root layout sets the attribute
 * before paint; this provider keeps React's copy in sync afterwards (including
 * live OS changes while the preference is `system`).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>('system');
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>('dark');
  // The pre-paint script already painted a theme. Waiting for this flag keeps
  // the provider from briefly overwriting a stored light preference with its
  // SSR default (dark) during the first effects pass.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setThemeState(readStoredTheme());

    if (typeof window.matchMedia !== 'function') {
      setReady(true);
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => {
      setSystemTheme(media.matches ? 'dark' : 'light');
    };

    sync();

    const onChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    media.addEventListener('change', onChange);
    setReady(true);

    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    if (!ready) {
      return;
    }

    applyTheme(resolvedTheme);
  }, [ready, resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference): void => {
    setThemeState(next);
    writeStoredTheme(next);

    // Apply synchronously as well as through the effect: a click should not
    // wait for a second render to change the page.
    applyTheme(next === 'system' ? getSystemTheme() : next);
  }, []);

  const toggleTheme = useCallback((): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (value === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }

  return value;
}

function readStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'system';
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The theme
    // still works for this tab; it just cannot outlive it.
    return 'system';
  }
}

function writeStoredTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // See readStoredTheme: persistence is best-effort, painting is not.
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = theme;
  // Keeps native controls and scrollbars in the same mode as the page.
  root.style.colorScheme = theme;
}
