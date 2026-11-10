import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  EXTENSION_ATTR_SCRUB_SCRIPT,
  PRE_HYDRATION_SCRIPT,
  THEME_BOOT_SCRIPT,
} from './boot-scripts';
import { THEME_STORAGE_KEY } from '../lib/theme-config';

/**
 * The boot scripts are `dangerouslySetInnerHTML` strings, so nothing under
 * normal rendering executes them. Running the exact text against the jsdom
 * document keeps them honest: a script that grew a syntax error or stopped
 * removing extension attributes fails here, not on a user's browser.
 */
describe('pre-hydration boot scripts', () => {
  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  describe('THEME_BOOT_SCRIPT', () => {
    it('marks a stored dark preference on <html> before first paint', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

      runInline(THEME_BOOT_SCRIPT);

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('stores an explicit light preference', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light');

      runInline(THEME_BOOT_SCRIPT);

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('falls back to light when storage holds a value it does not know', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');

      runInline(THEME_BOOT_SCRIPT);

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('survives storage being unavailable', () => {
      // Private-browsing modes can make just reading `window.localStorage`
      // throw. jsdom's own Storage methods cannot be spied on, so replace the
      // accessor - which is closer to how a browser fails anyway.
      const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('storage blocked');
        },
      });

      runInline(THEME_BOOT_SCRIPT);

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');

      if (original) {
        Object.defineProperty(window, 'localStorage', original);
      }
    });
  });

  describe('EXTENSION_ATTR_SCRUB_SCRIPT', () => {
    it('removes extension-injected attributes React never rendered', () => {
      const { element } = elementWith('bis_skin_checked');

      runInline(EXTENSION_ATTR_SCRUB_SCRIPT);

      expect(element.hasAttribute('bis_skin_checked')).toBe(false);
    });

    it('leaves attributes the app itself manages', () => {
      const div = document.createElement('div');
      div.setAttribute('bis_skin_checked', '1');
      div.setAttribute('data-theme', 'dark');
      document.body.appendChild(div);

      runInline(EXTENSION_ATTR_SCRUB_SCRIPT);

      expect(div.getAttribute('data-theme')).toBe('dark');
    });

    it('keeps scrubbing attributes injected after the boot script ran', async () => {
      runInline(EXTENSION_ATTR_SCRUB_SCRIPT);

      const element = document.createElement('div');
      element.setAttribute('bis_skin_checked', '1');
      document.body.appendChild(element);
      await flushMutations();

      expect(element.hasAttribute('bis_skin_checked')).toBe(false);
    });
  });

  describe('PRE_HYDRATION_SCRIPT', () => {
    it('is the theme boot first, then the scrub, so the theme lands before paint', () => {
      expect(PRE_HYDRATION_SCRIPT.startsWith(THEME_BOOT_SCRIPT)).toBe(true);
      expect(PRE_HYDRATION_SCRIPT).toContain(EXTENSION_ATTR_SCRUB_SCRIPT);
    });

    it('is what the root layout actually ships', () => {
      const layout = readFileSync(path.join(__dirname, 'layout.tsx'), 'utf8');

      expect(layout).toContain(
        `<script nonce={nonce} dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_SCRIPT }} />`,
      );
    });
  });

  /**
   * Runs a boot script against the browser globals the inline `<script>` in the
   * layout would see at parse time.
   */
  function runInline(script: string): void {
    // The text is authored by this repo, not user input - the eval risk the
    // lint rule guards against does not apply.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(script)();
  }

  function elementWith(attribute: string): { element: HTMLDivElement } {
    const element = document.createElement('div');
    element.setAttribute(attribute, '1');
    document.body.appendChild(element);
    return { element };
  }

  /**
   * MutationObserver callbacks are delivered as a microtask after the change.
   * A single zero-delay macrotask is enough for jsdom to flush the queue, with
   * no wall-clock sleep involved.
   */
  function flushMutations(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
});
