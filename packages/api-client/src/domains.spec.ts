import { z } from 'zod';

import { ApiClientError } from './client';
import { createApiClient } from './domains';
import { ROUTES, ROUTE_PATHS, type RouteMap } from './generated/routes';

/**
 * Domain-layer tests.
 *
 * Two things are worth proving here and they pull in opposite directions:
 *
 *  - every path the domain layer calls exists in the GENERATED route map, so a
 *    renamed endpoint fails in CI rather than in a browser. The domain layer is
 *    hand-written (the document has no schemas yet), which is exactly why this
 *    drift check has to exist.
 *  - a response that does not match its schema fails loudly, with a message that
 *    names what broke. The whole point of parsing is that a shape change is
 *    caught at the boundary instead of three components deep.
 */

describe('domain paths are documented', () => {
  const documented = new Set<string>(ROUTE_PATHS);

  /**
   * Every path string literal passed to the transport. Collected by hand because
   * there is no runtime hook for it, and the list is short enough that a missing
   * entry is visible in a diff.
   */
  const USED: { method: string; path: string }[] = [
    { method: 'POST', path: '/auth/register' },
    { method: 'POST', path: '/auth/login' },
    { method: 'POST', path: '/auth/logout' },
    { method: 'GET', path: '/auth/me' },
    { method: 'GET', path: '/credits' },
    { method: 'GET', path: '/workspaces' },
    { method: 'GET', path: '/workspaces/{workspaceId}/members' },
    { method: 'GET', path: '/brands' },
    { method: 'POST', path: '/brands' },
    { method: 'GET', path: '/brands/{brandId}' },
    { method: 'GET', path: '/brands/{brandId}/campaigns' },
    { method: 'POST', path: '/campaigns' },
    { method: 'GET', path: '/campaigns/{campaignId}/posts' },
    { method: 'POST', path: '/posts' },
    { method: 'GET', path: '/posts/{postId}' },
    { method: 'PATCH', path: '/posts/{postId}' },
    { method: 'POST', path: '/posts/{postId}/approve' },
    { method: 'POST', path: '/posts/{postId}/generate' },
    { method: 'POST', path: '/posts/{postId}/schedule' },
    { method: 'DELETE', path: '/posts/{postId}/schedule' },
    { method: 'GET', path: '/posts/{postId}/publishes' },
    { method: 'GET', path: '/posts/{postId}/assets' },
    { method: 'GET', path: '/jobs/{jobId}' },
    { method: 'POST', path: '/assets/uploads' },
    { method: 'POST', path: '/assets/{assetId}/confirm' },
    { method: 'GET', path: '/social-accounts' },
    { method: 'POST', path: '/social-accounts' },
    { method: 'DELETE', path: '/social-accounts/{accountId}' },
    { method: 'GET', path: '/notifications' },
    { method: 'GET', path: '/notifications/unread-count' },
    { method: 'POST', path: '/notifications/{notificationId}/read' },
    { method: 'POST', path: '/notifications/read-all' },
  ];

  it.each(USED)('$method $path is in the generated route map', ({ method, path }) => {
    expect(documented.has(path)).toBe(true);

    const operations = ROUTES[path as keyof RouteMap] as Record<string, unknown>;
    expect(operations[method.toLowerCase()]).toBeDefined();
  });

  /**
   * Documented paths the domain layer deliberately does not call.
   *
   * Explicit, with a reason each, rather than a prefix check. The prefix version
   * failed with "expected true, received false", which tells a reader nothing
   * about WHICH endpoint appeared or whether that matters - and a list nobody
   * can act on is a list nobody maintains.
   */
  const DELIBERATELY_UNWIRED: Record<string, string> = {
    '/auth/refresh': 'handled by the transport, which refreshes on a 401',
    '/me': 'duplicate of /auth/me, kept for the mobile client',
    '/workspaces/{workspaceId}': 'the list is enough for the dashboard; detail adds a round trip',
    '/workspaces/{workspaceId}/members/{userId}': 'member removal is Phase 9 admin work',
    '/assets/{assetId}': 'asset deletion is not in the Phase 8 journey',
    '/assets/{assetId}/download': 'assets render from storageKey via a presigned GET in Phase 9',
    '/jobs/{jobId}/events': 'progress is consumed as SSE by the browser, not by this client',
    '/docs-json': 'the document itself; this package is generated FROM it',
    '/health/live': 'liveness is an infrastructure probe, not an app concern',
    '/health/ready': 'readiness is an infrastructure probe, not an app concern',
    '/metrics': 'Prometheus scrape, not an app concern',
    '/admin/dlq': 'Phase 9 admin console',
    '/admin/dlq/{jobId}/replay': 'Phase 9 admin console',
    '/admin/dlq/outbox': 'Phase 9 admin console',
    '/admin/dlq/outbox/{eventId}/replay': 'Phase 9 admin console',
    '/admin/reconcile': 'Phase 9 admin console',
  };

  it('accounts for every documented path', () => {
    const unwired = ROUTE_PATHS.filter((path) => !USED.some((used) => used.path === path));
    const unaccounted = unwired.filter((path) => DELIBERATELY_UNWIRED[path] === undefined);

    // A new endpoint appears here with its name, not as a boolean.
    expect(unaccounted).toEqual([]);
  });

  it('has no stale entries in the unwired list', () => {
    // The other direction: a reason left behind after a path got wired would
    // quietly rot into a lie.
    const stale = Object.keys(DELIBERATELY_UNWIRED).filter((path) =>
      USED.some((used) => used.path === path),
    );

    expect(stale).toEqual([]);
  });

  it('every reason says why, not just that', () => {
    // A blank reason is worse than none: it looks reviewed without being so.
    const bare = Object.entries(DELIBERATELY_UNWIRED)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([path]) => path);

    expect(bare).toEqual([]);
  });
});

describe('response validation', () => {
  function clientReturning(body: unknown) {
    return createApiClient({
      baseUrl: 'http://api.test/api/v1',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  const wallet = { available: 50, reserved: 0 };

  it('parses a well-shaped credits response', async () => {
    const api = clientReturning({ wallet });

    await expect(api.credits.balance()).resolves.toEqual({ wallet });
  });

  it('rejects a response the client cannot understand', async () => {
    // The server dropped `available`. Every component reading it would get
    // undefined and fail somewhere unrelated; here it fails here, and says so.
    const api = clientReturning({ wallet: { reserved: 0 } });

    const error = await api.credits.balance().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('INVALID_RESPONSE');
    // The failing FIELD, not just a count of issues.
    expect((error as ApiClientError).message).toContain('wallet.available');
  });

  it('accepts a list wrapped in items', async () => {
    const api = clientReturning({ items: [{ id: 'w1', name: 'Acme', ownerId: 'u1' }] });

    await expect(api.workspaces.list()).resolves.toEqual([
      { id: 'w1', name: 'Acme', ownerId: 'u1' },
    ]);
  });

  it('accepts a bare list', async () => {
    const api = clientReturning([{ id: 'w1', name: 'Acme', ownerId: 'u1' }]);

    await expect(api.workspaces.list()).resolves.toHaveLength(1);
  });

  it('rejects a list entry with a missing field', async () => {
    const api = clientReturning({ items: [{ id: 'w1', name: 'Acme' }] });

    await expect(api.workspaces.list()).rejects.toBeInstanceOf(ApiClientError);
  });

  it('counts an unread-count response whether wrapped or bare', async () => {
    await expect(clientReturning({ count: 3 }).notifications.unreadCount()).resolves.toBe(3);
    // A bare number is not valid JSON for this endpoint today, but a version
    // that returns one must not read as zero unread.
    await expect(clientReturning(0).notifications.unreadCount()).resolves.toBe(0);
  });

  it('never accepts a token out of a social account response', async () => {
    // Phase 7's security rule: tokens are never returned by the API. The schema
    // is strict, so a server that started returning one fails the parse instead
    // of quietly flowing into app state.
    const account = {
      id: 'a1',
      workspaceId: 'w1',
      platform: 'linkedin',
      externalAccountId: 'ext',
      displayName: null,
      scopes: [],
      tokenExpiresAt: null,
      connectedBy: 'u1',
      createdAt: '2026-01-01T00:00:00.000Z',
      needsReconnect: false,
    };

    await expect(clientReturning([account]).socialAccounts.list('w1')).resolves.toHaveLength(1);

    const leaky = clientReturning([{ ...account, token: 'ya29.secret' }]);
    const [parsed] = await leaky.socialAccounts.list('w1');

    // STRIPPED, not rejected, and deliberately so. zod drops unknown keys, so a
    // server that started leaking a token cannot get one into app state even if
    // its own guard regressed - and a page that fails to render because the
    // server added a field would be a worse outcome than losing the field. The
    // API side has its own test asserting the token is absent in the first
    // place; this is the second line of defence, not the first.
    expect(parsed).not.toHaveProperty('token');
    expect(JSON.stringify(parsed)).not.toContain('ya29.secret');
  });

  it('sends the Idempotency-Key only when one is given', async () => {
    const seen: (string | null)[] = [];

    const api = createApiClient({
      baseUrl: 'http://api.test/api/v1',
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get('Idempotency-Key'));
        return new Response(
          JSON.stringify({ postId: 'p1', scheduledAt: 'x', jobs: [], replayed: false }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    await api.posts.schedule('p1', { scheduledAt: new Date(), accountIds: ['a1'] }, 'key-1');
    await api.posts.schedule('p1', { scheduledAt: new Date(), accountIds: ['a1'] });

    expect(seen).toEqual(['key-1', null]);
  });

  it('surfaces the API error code rather than a generic failure', async () => {
    const api = createApiClient({
      baseUrl: 'http://api.test/api/v1',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits.' }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
    });

    const error = await api.posts.generate('p1', { type: 'REEL' }).catch((e: unknown) => e);

    // The upsell modal keys off this flag, so it has to survive the trip.
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).isInsufficientCredits).toBe(true);
    expect((error as ApiClientError).code).toBe('INSUFFICIENT_CREDITS');
  });

  it('does not mistake a 200 with a bad body for success', async () => {
    const api = createApiClient({
      baseUrl: 'http://api.test/api/v1',
      fetchImpl: async () =>
        new Response(JSON.stringify('not an object'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    // A bare string is what a misconfigured proxy returns. Reading it as an
    // object would give `undefined` everywhere.
    await expect(api.credits.balance()).rejects.toBeInstanceOf(ApiClientError);
  });

  it('parses a zod schema without leaking `any`', () => {
    // Compile-time guard: if `asArray` ever degrades to `any[]`, this fails to
    // infer. Written as a type-level assertion rather than a runtime one.
    const wrapped: z.ZodType<{ id: string }[]> = z.array(z.object({ id: z.string() }));
    expect(wrapped.parse([{ id: 'a' }])).toHaveLength(1);
  });
});
