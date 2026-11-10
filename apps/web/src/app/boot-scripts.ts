import { THEME_STORAGE_KEY } from '../lib/theme-config';

/**
 * Scripts that must run before React hydrates, shipped as one inline `<script>`
 * in the root layout.
 *
 * Inline because both jobs are only correct if they finish while the browser is
 * still parsing: a `next/script` tag or a React effect runs after the first
 * paint, which is one frame late for the theme and a whole hydration error late
 * for the scrub. They live in a plain module rather than inside `layout.tsx` so
 * `boot-scripts.spec.ts` can execute them against a real DOM instead of
 * asserting on a string.
 */

/**
 * Attributes known to be injected by browser extensions rather than by the
 * server HTML or the app. Extend this list if a new extension causes the same
 * hydration report; do not grow it with attributes the app itself would emit.
 */
const EXTENSION_INJECTED_ATTRIBUTES = ['bis_skin_checked'];

/**
 * Sets the stored theme before the first paint, so a reload with a stored light
 * preference never flashes the dark default (see the guide in
 * `next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`).
 */
export const THEME_BOOT_SCRIPT = `(function () {
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme = stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.colorScheme = 'light';
  }
})();`;

/**
 * Removes attributes that browser extensions inject into the DOM.
 *
 * `bis_skin_checked` ships with several AI-sidebar extensions. It is not in the
 * server HTML, so when it lands on an element before React hydrates, React sees
 * an attribute mismatch on entire subtrees, logs a hydration error in dev and,
 * in production, recovers by re-rendering whole subtrees from the client - a
 * visible flash with no real cause. The report in `marketing.tsx` looked like a
 * bug in the page; the diff was entirely this attribute.
 *
 * The scrub is best effort, not a `suppressHydrationWarning` on every element:
 * it deletes exactly the known extension attributes, so a genuine app mismatch
 * still surfaces. Each removal trip is bounded - removing the attribute fires
 * one more mutation record, the re-scrub finds nothing, and the chain ends.
 */
export const EXTENSION_ATTR_SCRUB_SCRIPT = `(function () {
  var INJECTED = ${JSON.stringify(EXTENSION_INJECTED_ATTRIBUTES)};
  var selector = INJECTED.map(function (attr) {
    return '[' + attr + ']';
  }).join(',');
  function scrub() {
    try {
      var nodes = document.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i += 1) {
        for (var j = 0; j < INJECTED.length; j += 1) {
          nodes[i].removeAttribute(INJECTED[j]);
        }
      }
    } catch (error) {
      // Cosmetic cleanup: never let it break the theme boot around it.
    }
  }
  scrub();
  try {
    // Extensions often run at document_idle, after this script. The observer
    // catches injections that happen after the one-shot scrub above.
    new MutationObserver(scrub).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributeFilter: INJECTED,
    });
  } catch (error) {
    // No MutationObserver: the one-shot scrub already ran.
  }
})();`;

/**
 * The script text for the `<script nonce>` element in the root layout. One
 * element, theme first (the scrub must not delay the theme landing before
 * paint).
 */
export const PRE_HYDRATION_SCRIPT = `${THEME_BOOT_SCRIPT}
${EXTENSION_ATTR_SCRUB_SCRIPT}`;
