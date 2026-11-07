import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeToggle } from '../components/theme-toggle';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from './theme';

function Probe() {
  const { theme, resolvedTheme } = useTheme();
  return <p data-testid="theme-state">{`${theme}:${resolvedTheme}`}</p>;
}

/**
 * The theme is a preference, not a stylesheet detail: it must survive a reload,
 * default to the white screen, and keep an explicit choice even when the OS
 * changes. The choice made on one page (for example the landing page) is read
 * back from local storage on every other page (for example the login page).
 * These tests exercise the provider through the same controls the shell uses.
 */
describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = '';
    installSystemTheme(false);
  });

  it('defaults to the white screen even when the OS is dark', async () => {
    installSystemTheme(true);

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies a stored preference instead of the OS', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    installSystemTheme(true);

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('toggles to the opposite explicit theme and persists it', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    // jsdom reports no dark-mode match, so the first explicit choice is dark.
    const toggle = await screen.findByRole('button', { name: 'Switch to dark theme' });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('tracks OS changes while the preference is system', async () => {
    // OS-following only happens when the user explicitly chose it: the default
    // is the white screen, so `system` has to be stored first.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const system = installSystemTheme(false);

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('theme-state')).toHaveTextContent('system:light');
    });

    act(() => {
      system.emit(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId('theme-state')).toHaveTextContent('system:dark');
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps an explicit choice when the OS changes', async () => {
    const system = installSystemTheme(false);

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));

    act(() => {
      system.emit(false);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

interface SystemTheme {
  emit: (matches: boolean) => void;
}

/**
 * A controllable `prefers-color-scheme` list.
 *
 * The global stub in `test/setup.ts` always reports "no match"; this one lets a
 * test choose the starting mode and emit the same change event a real OS setting
 * would.
 */
function installSystemTheme(matches: boolean): SystemTheme {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void): void => {
      listeners.delete(listener);
    },
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  };

  window.matchMedia = jest.fn().mockReturnValue(media);

  return {
    emit(next: boolean): void {
      media.matches = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    },
  };
}
