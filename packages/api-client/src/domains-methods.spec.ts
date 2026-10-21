import { ApiClientError } from './client';
import { createApiClient, type DomainClient } from './domains';

/**
 * Request composition for every domain method.
 *
 * `domains.spec.ts` proves that a few responses are parsed correctly and that
 * every path exists in the generated route map. This file answers the other half
 * of the question for the methods the app actually calls: does each one use the
 * documented verb, path, query and body?
 *
 * The stub answers `{}` for everything, so a method that validates its response
 * rejects with `INVALID_RESPONSE` after the request has been recorded. That is
 * deliberate: response shapes are covered by the fixtures in the other spec, and
 * repeating forty of them here would make this file about zod rather than about
 * the client's HTTP contract.
 */

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

function makeClient(): { api: DomainClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const api = createApiClient({
    baseUrl: 'http://api.test/api/v1',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api\/v1/, ''),
        query: url.searchParams,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: new Headers(init?.headers),
      });

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return { api, calls };
}

interface Case {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  idempotencyKey?: string;
  call: (api: DomainClient) => Promise<unknown>;
}

const ISO = '2026-10-20T10:00:00.000Z';

const CASES: Case[] = [
  {
    name: 'auth.register',
    method: 'POST',
    path: '/auth/register',
    body: { email: 'ada@example.test', password: 'correct-horse' },
    call: (api) => api.auth.register({ email: 'ada@example.test', password: 'correct-horse' }),
  },
  {
    name: 'auth.login',
    method: 'POST',
    path: '/auth/login',
    body: { email: 'ada@example.test', password: 'correct-horse' },
    call: (api) => api.auth.login({ email: 'ada@example.test', password: 'correct-horse' }),
  },
  { name: 'auth.logout', method: 'POST', path: '/auth/logout', call: (api) => api.auth.logout() },
  { name: 'auth.me', method: 'GET', path: '/auth/me', call: (api) => api.auth.me() },
  {
    name: 'credits.balance',
    method: 'GET',
    path: '/credits',
    call: (api) => api.credits.balance(),
  },
  {
    name: 'workspaces.list',
    method: 'GET',
    path: '/workspaces',
    call: (api) => api.workspaces.list(),
  },
  {
    name: 'workspaces.members',
    method: 'GET',
    path: '/workspaces/w1/members',
    call: (api) => api.workspaces.members('w1'),
  },
  { name: 'brands.list', method: 'GET', path: '/brands', call: (api) => api.brands.list() },
  {
    name: 'brands.create',
    method: 'POST',
    path: '/brands',
    body: { workspaceId: 'w1', name: 'Acme' },
    call: (api) => api.brands.create({ workspaceId: 'w1', name: 'Acme' }),
  },
  {
    name: 'brands.detail',
    method: 'GET',
    path: '/brands/b1',
    call: (api) => api.brands.detail('b1'),
  },
  {
    name: 'brands.campaigns',
    method: 'GET',
    path: '/brands/b1/campaigns',
    call: (api) => api.brands.campaigns('b1'),
  },
  {
    name: 'campaigns.create',
    method: 'POST',
    path: '/campaigns',
    body: { brandId: 'b1', goal: 'launch' },
    call: (api) => api.campaigns.create({ brandId: 'b1', goal: 'launch' }),
  },
  {
    name: 'campaigns.detail',
    method: 'GET',
    path: '/campaigns/c1',
    call: (api) => api.campaigns.detail('c1'),
  },
  {
    name: 'campaigns.posts',
    method: 'GET',
    path: '/campaigns/c1/posts',
    call: (api) => api.campaigns.posts('c1'),
  },
  {
    name: 'campaigns.analytics',
    method: 'GET',
    path: '/analytics/campaigns/c1',
    call: (api) => api.campaigns.analytics('c1'),
  },
  {
    name: 'analytics.overview',
    method: 'GET',
    path: '/analytics/overview',
    query: { workspaceId: 'w1' },
    call: (api) => api.analytics.overview('w1'),
  },
  {
    name: 'posts.create',
    method: 'POST',
    path: '/posts',
    body: { campaignId: 'c1', type: 'CAPTION' },
    call: (api) => api.posts.create({ campaignId: 'c1', type: 'CAPTION' }),
  },
  {
    name: 'posts.detail',
    method: 'GET',
    path: '/posts/p1',
    call: (api) => api.posts.detail('p1'),
  },
  {
    name: 'posts.update',
    method: 'PATCH',
    path: '/posts/p1',
    body: { caption: 'A better caption' },
    call: (api) => api.posts.update('p1', { caption: 'A better caption' }),
  },
  {
    name: 'posts.approve',
    method: 'POST',
    path: '/posts/p1/approve',
    call: (api) => api.posts.approve('p1'),
  },
  {
    name: 'posts.generate',
    method: 'POST',
    path: '/posts/p1/generate',
    body: { type: 'CAPTION' },
    idempotencyKey: 'generate-key',
    call: (api) => api.posts.generate('p1', { type: 'CAPTION' }, 'generate-key'),
  },
  {
    name: 'posts.schedule',
    method: 'POST',
    path: '/posts/p1/schedule',
    body: { scheduledAt: ISO, accountIds: ['a1'] },
    idempotencyKey: 'schedule-key',
    call: (api) =>
      api.posts.schedule('p1', { scheduledAt: new Date(ISO), accountIds: ['a1'] }, 'schedule-key'),
  },
  {
    name: 'posts.cancelSchedule',
    method: 'DELETE',
    path: '/posts/p1/schedule',
    call: (api) => api.posts.cancelSchedule('p1'),
  },
  {
    name: 'posts.reschedule',
    method: 'PATCH',
    path: '/posts/p1/schedule',
    body: { scheduledAt: ISO },
    call: (api) => api.posts.reschedule('p1', ISO),
  },
  {
    name: 'posts.publishes',
    method: 'GET',
    path: '/posts/p1/publishes',
    call: (api) => api.posts.publishes('p1'),
  },
  {
    name: 'posts.assets',
    method: 'GET',
    path: '/posts/p1/assets',
    call: (api) => api.posts.assets('p1'),
  },
  {
    name: 'posts.scheduled',
    method: 'GET',
    path: '/posts',
    query: { workspaceId: 'w1', from: '2026-10-01', to: '2026-10-31' },
    call: (api) => api.posts.scheduled('w1', { from: '2026-10-01', to: '2026-10-31' }),
  },
  {
    name: 'jobs.detail',
    method: 'GET',
    path: '/jobs/j1',
    call: (api) => api.jobs.detail('j1'),
  },
  {
    name: 'assets.requestUpload',
    method: 'POST',
    path: '/assets/uploads',
    body: { workspaceId: 'w1', fileName: 'poster.png' },
    call: (api) => api.assets.requestUpload({ workspaceId: 'w1', fileName: 'poster.png' }),
  },
  {
    name: 'assets.confirm',
    method: 'POST',
    path: '/assets/a1/confirm',
    call: (api) => api.assets.confirm('a1'),
  },
  {
    name: 'socialAccounts.list',
    method: 'GET',
    path: '/social-accounts',
    query: { workspaceId: 'w1' },
    call: (api) => api.socialAccounts.list('w1'),
  },
  {
    name: 'socialAccounts.connect',
    method: 'POST',
    path: '/social-accounts',
    body: { workspaceId: 'w1', platform: 'linkedin', externalAccountId: 'ext-1', accessToken: 't' },
    call: (api) =>
      api.socialAccounts.connect({
        workspaceId: 'w1',
        platform: 'linkedin',
        externalAccountId: 'ext-1',
        accessToken: 't',
      }),
  },
  {
    name: 'socialAccounts.disconnect',
    method: 'DELETE',
    path: '/social-accounts/a1',
    call: (api) => api.socialAccounts.disconnect('a1'),
  },
  {
    name: 'notifications.list',
    method: 'GET',
    path: '/notifications',
    query: { unread: 'false' },
    call: (api) => api.notifications.list(),
  },
  {
    name: 'notifications.unreadCount',
    method: 'GET',
    path: '/notifications/unread-count',
    call: (api) => api.notifications.unreadCount(),
  },
  {
    name: 'notifications.markRead',
    method: 'POST',
    path: '/notifications/n1/read',
    call: (api) => api.notifications.markRead('n1'),
  },
  {
    name: 'notifications.markAllRead',
    method: 'POST',
    path: '/notifications/read-all',
    call: (api) => api.notifications.markAllRead(),
  },
  {
    name: 'admin.dlq',
    method: 'GET',
    path: '/admin/dlq',
    query: { limit: '25' },
    call: (api) => api.admin.dlq(),
  },
  {
    name: 'admin.replayJob',
    method: 'POST',
    path: '/admin/dlq/j1/replay',
    call: (api) => api.admin.replayJob('j1'),
  },
  {
    name: 'admin.outbox',
    method: 'GET',
    path: '/admin/dlq/outbox',
    query: { limit: '50' },
    call: (api) => api.admin.outbox(),
  },
  {
    name: 'admin.replayOutbox',
    method: 'POST',
    path: '/admin/dlq/outbox/e1/replay',
    call: (api) => api.admin.replayOutbox('e1'),
  },
  {
    name: 'admin.reconcile',
    method: 'GET',
    path: '/admin/reconcile',
    call: (api) => api.admin.reconcile(),
  },
  {
    name: 'admin.adjustCredits',
    method: 'POST',
    path: '/admin/credits/adjust',
    body: { userId: 'u1', amount: 5, reason: 'goodwill' },
    call: (api) => api.admin.adjustCredits({ userId: 'u1', amount: 5, reason: 'goodwill' }),
  },
];

describe('domain methods compose the documented request', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const { api, calls } = makeClient();

      // Whether the stub body parses is not the subject; the request is recorded
      // before the parse runs, which is exactly what this test reads.
      await testCase.call(api).catch((error: unknown) => {
        expect(error).toBeInstanceOf(ApiClientError);
      });

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call).toBeDefined();

      expect(call?.method).toBe(testCase.method);
      expect(call?.path).toBe(testCase.path);

      for (const [key, value] of Object.entries(testCase.query ?? {})) {
        expect(call?.query.get(key)).toBe(value);
      }

      if (testCase.body !== undefined) {
        expect(call?.body).toEqual(testCase.body);
      }

      if (testCase.idempotencyKey !== undefined) {
        expect(call?.headers.get('Idempotency-Key')).toBe(testCase.idempotencyKey);
      }
    },
  );
});
