import '@testing-library/jest-dom';

/**
 * Web test setup.
 *
 * Two jobs, both about globals jsdom does not provide.
 */

/**
 * A minimal `Response` for the api-client's `fetchImpl` seam.
 *
 * `jest-environment-jsdom` removes the fetch family, because jsdom implements
 * none of it. The alternative to this is to pull Node's `Response` back onto the
 * global, which works but means a test that builds a response is using two
 * different Response implementations depending on which package's jest project
 * it runs under.
 *
 * This fake implements exactly what the transport reads - `ok`, `status`,
 * `headers.get`, `json()`, `text()` - and nothing else. Anything the transport
 * starts reading in future shows up as `undefined` here rather than as a test
 * that passes for the wrong reason.
 */
export function stubResponse(status: number, body: unknown): Response {
  const serialised = JSON.stringify(body);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    // Promise-returning, not async: the transport awaits them, and an `async`
    // function with no `await` is a lint error that says nothing useful here.
    json: (): Promise<unknown> => Promise.resolve(JSON.parse(serialised) as unknown),
    text: (): Promise<string> => Promise.resolve(serialised),
  } as unknown as Response;
}

/**
 * jsdom has no `matchMedia`, which responsive components read on mount. Stubbed
 * to "no match" so a component under test fails on its own logic rather than on
 * a missing global.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * `IntersectionObserver` for the same reason. A scroll-triggered component would
 * otherwise throw on mount in every test.
 */
if (typeof window !== 'undefined' && typeof window.IntersectionObserver !== 'function') {
  class StubIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    disconnect(): void {}
    observe(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve(): void {}
  }

  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: StubIntersectionObserver,
  });
}
