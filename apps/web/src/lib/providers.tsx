'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';

import { ApiClientError, createApiClient, type DomainClient } from '@renderflow/api-client';

import { API_BASE_URL } from './api-url';
import { ThemeProvider } from './theme';

/**
 * The API client, as a React context.
 *
 * A provider rather than a module-level singleton so tests can inject a client
 * with a stub `fetch` (AGENTS.md section 9: no real network in tests) and so the
 * server can create a fresh one per request instead of sharing state across
 * users.
 */
const ApiContext = createContext<DomainClient | null>(null);

export function useApi(): DomainClient {
  const client = useContext(ApiContext);

  if (client === null) {
    // A hook called outside the provider is a wiring mistake, and returning a
    // module-level default would hide it until something 500s in a browser.
    throw new Error('useApi must be used inside <Providers>');
  }

  return client;
}

/**
 * Echoes the API's non-httpOnly CSRF cookie back as a header.
 *
 * The cookie is deliberately readable by JS: that is the "double submit" half of
 * the CSRF defence. Without this, every POST/PATCH/DELETE from the browser is
 * rejected with CSRF_TOKEN_INVALID even though the session cookie is valid.
 */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  for (const part of document.cookie.split('; ')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator) === 'rf_csrf') {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }

  return null;
}

/**
 * Builds a client for tests and for the browser.
 *
 * `fetchImpl` is the seam. Production passes nothing and gets the platform
 * `fetch`; a test passes a stub and never touches a socket.
 */
export function createBrowserApiClient(
  overrides: Partial<Parameters<typeof createApiClient>[0]> = {},
): DomainClient {
  return createApiClient({
    baseUrl: API_BASE_URL,
    // The access token lives in an httpOnly cookie, so `credentials: 'include'`
    // is what authenticates every request. Without it the browser silently omits
    // the cookie and the API answers 401 - which looks exactly like bad auth.
    withCredentials: true,
    getCsrfToken: readCsrfCookie,
    ...overrides,
  });
}

export function Providers({
  children,
  client,
  queryClient: injectedQueryClient,
}: {
  children: ReactNode;
  /** Injected by tests; production builds one per mount. */
  client?: DomainClient;
  /**
   * Injected by tests that need different cache behaviour (no retries, nothing
   * cached between tests).
   *
   * An INJECTION POINT rather than "wrap it in your own QueryClientProvider":
   * a provider outside this one is shadowed by the one created below, so the
   * test's settings would silently not apply - which looks exactly like a
   * component ignoring its query options.
   */
  queryClient?: QueryClient;
}) {
  // `useState` with an initialiser, not a module constant: a QueryClient holds
  // cache and timers, and sharing one across requests on the server would leak
  // one user's data into another's render.
  const [queryClient] = useState(
    () =>
      injectedQueryClient ??
      new QueryClient({
        defaultOptions: {
          queries: {
            // The API is cookie-authenticated and the data is the user's own;
            // refetching on every window focus makes the credit balance flicker
            // for no reason.
            refetchOnWindowFocus: false,
            staleTime: 15_000,
            retry: (failureCount, failure) => {
              // Retrying a 401 just produces another 401, slower. A 402 is the
              // upsell, not an error to retry.
              if (
                failure instanceof ApiClientError &&
                (failure.status === 401 || failure.status === 403)
              ) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            // Never retry a mutation automatically. Every one of them either
            // charges credits or publishes a post, and a silent retry is how a
            // user pays twice for one click.
            retry: false,
          },
        },
      }),
  );

  const [apiClient] = useState(() => client ?? createBrowserApiClient());

  return (
    <ThemeProvider>
      <ApiContext.Provider value={apiClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ApiContext.Provider>
    </ThemeProvider>
  );
}
