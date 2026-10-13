import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

import { ApiClientError, createApiClient, type DomainClient } from '@renderflow/api-client';

import { stubResponse } from '../../test/setup';

import { Providers } from '../lib/providers';

/**
 * Test harness.
 *
 * A stub `fetch` rather than a running API: AGENTS.md section 9 forbids real
 * network in tests, and a suite that needs Postgres and Redis to check a button
 * is a button does not get run.
 *
 * What it DOES model is the parts that matter to a component - status codes,
 * error bodies, and the api-client's own response validation - because a stub
 * that returns `200 {}` for everything would pass tests that only a broken
 * server could make pass.
 */

export interface StubRoute {
  status?: number;
  body?: unknown;
  /** Thrown instead of answering, for the offline case. */
  throws?: Error;
}

/**
 * What a dynamic stub is handed.
 *
 * A plain descriptor, not a `Request`: jsdom has no `Request` constructor, so
 * building one throws a ReferenceError that the transport reports as a
 * NETWORK_ERROR - which looks exactly like a flaky test rather than a harness bug.
 */
export interface StubRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Routes = Record<string, StubRoute | ((request: StubRequest) => StubRoute)>;

export interface StubApi {
  client: DomainClient;
  /** Every request the client made, in order. */
  calls: { method: string; url: string; body: unknown }[];
}

/**
 * Builds a client whose transport answers from `routes`.
 *
 * Keys are `METHOD /path`; the path is matched with `{param}` placeholders, so a
 * test states `/posts/:postId/schedule` and gets whichever id it used.
 */
export function stubApi(routes: Routes): StubApi {
  const calls: { method: string; url: string; body: unknown }[] = [];

  // Synchronous body, Promise-returning: it never awaits, because every answer
  // comes from `routes`. Declared `async` with no `await` would be a lint error
  // that says nothing about the code.
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(input);

    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    // Stripped to the path AFTER the API prefix, so a test writes `/auth/me`
    // rather than `/api/v1/auth/me` - and stays correct if the prefix changes.
    const path = url.pathname.replace(/^\/api\/v\d+/, '') || '/';

    calls.push({ method, url: `${path}${url.search}`, body });

    const route = match(routes, method, path);

    if (route === undefined) {
      return Promise.resolve(
        stubResponse(404, { code: 'NOT_FOUND', message: `no stub for ${method} ${path}` }),
      );
    }

    const resolved =
      typeof route === 'function'
        ? route({ method, path, body, headers: normaliseHeaders(init?.headers) })
        : route;

    if (resolved.throws !== undefined) {
      return Promise.reject(resolved.throws);
    }

    return Promise.resolve(stubResponse(resolved.status ?? 200, resolved.body ?? {}));
  };

  const client = createApiClient({
    baseUrl: 'http://api.test/api/v1',
    withCredentials: true,
    fetchImpl: (input, init) => fetchImpl(input, init),
  });

  return { client, calls };
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const flat: Record<string, string> = {};

  if (headers === undefined) {
    return flat;
  }

  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      flat[name] = value;
    }
    return flat;
  }

  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, name) => {
      flat[name] = value;
    });
    return flat;
  }

  return { ...(headers as Record<string, string>) };
}

function match(
  routes: Routes,
  method: string,
  path: string,
): StubRoute | ((r: StubRequest) => StubRoute) | undefined {
  const exact = routes[`${method} ${path}`];
  if (exact !== undefined) {
    return exact;
  }

  for (const [key, route] of Object.entries(routes)) {
    const [keyMethod, keyPath] = key.split(' ');
    if (keyMethod !== method) {
      continue;
    }

    if (matches(keyPath ?? '', path)) {
      return route;
    }
  }

  return undefined;
}

function matches(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');

  if (patternParts.length !== pathParts.length) {
    return false;
  }

  return patternParts.every((part, index) => {
    if (part.startsWith('{')) {
      return pathParts[index] !== undefined && pathParts[index] !== '';
    }
    return part === pathParts[index];
  });
}

/**
 * Renders a component inside the real providers.
 *
 * A fresh `QueryClient` per test: a shared one leaks cached data between tests,
 * and the failure looks like a component that renders stale state rather than a
 * dirty test.
 */
export function renderWithProviders(
  ui: ReactElement,
  client: DomainClient,
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Deterministic: no retries, and nothing cached between tests. AGENTS.md
      // section 9 - no reliance on wall-clock waits.
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  const result = render(
    <Providers client={client} queryClient={queryClient}>
      {ui}
    </Providers>,
  );

  return result;
}

/** Convenience for asserting a request carried a particular header. */
export function apiError(status: number, code: string, message: string): ApiClientError {
  return new ApiClientError(status, code, message);
}

/** Waits for a heading, which is how every screen announces itself. */
export async function findHeading(name: RegExp): Promise<HTMLElement> {
  return waitFor(() => screen.findByRole('heading', { name }));
}

/** Asserts a list contains an item whose text matches, without index maths. */
export function listHasItem(list: HTMLElement, text: RegExp): boolean {
  return within(list)
    .queryAllByRole('listitem')
    .some((item) => text.test(item.textContent ?? ''));
}

export { userEvent };
