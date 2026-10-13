import { z } from 'zod';

import type { RenderFlowClient, RenderFlowClientOptions } from './client';
import type { RequestOptions } from './types';
import { createRenderFlowClient } from './client';
import {
  authResponseSchema,
  brandSchema,
  campaignSchema,
  connectAccountRequestSchema,
  createBrandRequestSchema,
  createCampaignRequestSchema,
  createPostRequestSchema,
  creditsResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  jobSchema,
  meResponseSchema,
  memberSchema,
  notificationSchema,
  postSchema,
  presignedUploadSchema,
  publishJobSchema,
  scheduleRequestSchema,
  scheduleResponseSchema,
  socialAccountSchema,
  updatePostRequestSchema,
  workspaceSchema,
  type AuthResponse,
  type Brand,
  type Campaign,
  type ConnectAccountRequest,
  type CreditsResponse,
  type GenerateRequest,
  type GenerateResponse,
  type Job,
  type Member,
  type MeResponse,
  type Notification,
  type Post,
  type PresignedUpload,
  type PublishJob,
  type ScheduleRequest,
  type ScheduleResponse,
  type SocialAccount,
  type Workspace,
} from './schemas';
import { ApiClientError } from './client';

/**
 * The typed domain layer.
 *
 * Every call parses its response with a zod schema. That is the whole point of
 * this layer existing on top of a generic transport: the transport trusts the
 * server, this does not, and the difference shows up as a named parse failure
 * at the call site instead of `undefined` three components deep.
 *
 * Paths are checked against the generated route map by `routes.spec.ts`, so a
 * renamed endpoint fails there rather than at runtime in a browser.
 */

/** Runs a zod schema, turning a mismatch into an ApiClientError. */
async function parse<S extends z.ZodType>(
  run: () => Promise<unknown>,
  schema: S,
  what: string,
): Promise<z.infer<S>> {
  const raw = await run();

  const result = schema.safeParse(raw);

  if (!result.success) {
    // Includes the first issue, not a count: "expected string, received
    // undefined at user.email" tells a developer what to fix; "3 issues" does
    // not.
    const first = result.error.issues[0];
    const where = first?.path.length === 0 ? what : `${what} (at ${first?.path.join('.')})`;

    throw new ApiClientError(
      200,
      'INVALID_RESPONSE',
      `the API returned a ${where} this client does not understand: ${first?.message ?? 'unknown'}`,
      result.error.issues,
    );
  }

  return result.data;
}

export interface DomainClient {
  readonly transport: RenderFlowClient;

  auth: {
    register(body: unknown, options?: RequestOptions): Promise<AuthResponse>;
    login(body: unknown, options?: RequestOptions): Promise<AuthResponse>;
    logout(options?: RequestOptions): Promise<void>;
    me(options?: RequestOptions): Promise<MeResponse>;
  };

  credits: {
    balance(options?: RequestOptions): Promise<CreditsResponse>;
  };

  workspaces: {
    list(options?: RequestOptions): Promise<Workspace[]>;
    members(workspaceId: string, options?: RequestOptions): Promise<Member[]>;
  };

  brands: {
    list(options?: RequestOptions): Promise<Brand[]>;
    create(body: unknown, options?: RequestOptions): Promise<Brand>;
    detail(brandId: string, options?: RequestOptions): Promise<Brand>;
    campaigns(brandId: string, options?: RequestOptions): Promise<Campaign[]>;
  };

  campaigns: {
    create(body: unknown, options?: RequestOptions): Promise<Campaign>;
    posts(campaignId: string, options?: RequestOptions): Promise<Post[]>;
  };

  posts: {
    create(body: unknown, options?: RequestOptions): Promise<Post>;
    update(postId: string, body: unknown, options?: RequestOptions): Promise<Post>;
    approve(postId: string, options?: RequestOptions): Promise<Post>;
    generate(
      postId: string,
      body: unknown,
      idempotencyKey?: string,
      options?: RequestOptions,
    ): Promise<GenerateResponse>;
    schedule(
      postId: string,
      body: unknown,
      idempotencyKey?: string,
      options?: RequestOptions,
    ): Promise<ScheduleResponse>;
    cancelSchedule(postId: string, options?: RequestOptions): Promise<{ cancelled: number }>;
    publishes(postId: string, options?: RequestOptions): Promise<PublishJob[]>;
    assets(postId: string, options?: RequestOptions): Promise<unknown[]>;
  };

  jobs: {
    detail(jobId: string, options?: RequestOptions): Promise<Job>;
  };

  assets: {
    requestUpload(body: unknown, options?: RequestOptions): Promise<PresignedUpload>;
    confirm(assetId: string, options?: RequestOptions): Promise<unknown>;
  };

  socialAccounts: {
    list(workspaceId: string, options?: RequestOptions): Promise<SocialAccount[]>;
    connect(body: unknown, options?: RequestOptions): Promise<SocialAccount>;
    disconnect(accountId: string, options?: RequestOptions): Promise<{ disconnected: boolean }>;
  };

  notifications: {
    list(unreadOnly?: boolean, options?: RequestOptions): Promise<Notification[]>;
    unreadCount(options?: RequestOptions): Promise<number>;
    markRead(notificationId: string, options?: RequestOptions): Promise<{ updated: boolean }>;
    markAllRead(options?: RequestOptions): Promise<{ updated: number }>;
  };
}

export function createApiClient(options: RenderFlowClientOptions): DomainClient {
  const transport = createRenderFlowClient(options);

  return {
    transport,

    auth: {
      register: (body, opts) =>
        parse(
          () => transport.post('/auth/register', body, opts),
          authResponseSchema,
          'auth.register',
        ),
      login: (body, opts) =>
        parse(() => transport.post('/auth/login', body, opts), authResponseSchema, 'auth.login'),
      logout: async (opts) => {
        await transport.post('/auth/logout', undefined, opts);
      },
      me: (opts) => parse(() => transport.get('/auth/me', opts), meResponseSchema, 'auth.me'),
    },

    credits: {
      balance: (opts) =>
        parse(() => transport.get('/credits', opts), creditsResponseSchema, 'credits'),
    },

    workspaces: {
      list: (opts) =>
        parse(() => transport.get('/workspaces', opts), asArray(workspaceSchema), 'workspaces'),
      members: (workspaceId, opts) =>
        parse(
          () => transport.get(`/workspaces/${workspaceId}/members`, opts),
          asArray(memberSchema),
          'workspaces.members',
        ),
    },

    brands: {
      list: (opts) => parse(() => transport.get('/brands', opts), asArray(brandSchema), 'brands'),
      create: (body, opts) =>
        parse(() => transport.post('/brands', body, opts), brandSchema, 'brands.create'),
      detail: (brandId, opts) =>
        parse(() => transport.get(`/brands/${brandId}`, opts), brandSchema, 'brands.detail'),
      campaigns: (brandId, opts) =>
        parse(
          () => transport.get(`/brands/${brandId}/campaigns`, opts),
          asArray(campaignSchema),
          'brands.campaigns',
        ),
    },

    campaigns: {
      create: (body, opts) =>
        parse(() => transport.post('/campaigns', body, opts), campaignSchema, 'campaigns.create'),
      posts: (campaignId, opts) =>
        parse(
          () => transport.get(`/campaigns/${campaignId}/posts`, opts),
          asArray(postSchema),
          'campaigns.posts',
        ),
    },

    posts: {
      create: (body, opts) =>
        parse(() => transport.post('/posts', body, opts), postSchema, 'posts.create'),
      update: (postId, body, opts) =>
        parse(() => transport.patch(`/posts/${postId}`, body, opts), postSchema, 'posts.update'),
      approve: (postId, opts) =>
        parse(
          () => transport.post(`/posts/${postId}/approve`, undefined, opts),
          postSchema,
          'posts.approve',
        ),
      generate: (postId, body, idempotencyKey, opts) =>
        parse(
          () =>
            transport.post(
              `/posts/${postId}/generate`,
              body,
              withIdempotency(idempotencyKey, opts),
            ),
          generateResponseSchema,
          'posts.generate',
        ),
      schedule: (postId, body, idempotencyKey, opts) =>
        parse(
          () =>
            transport.post(
              `/posts/${postId}/schedule`,
              body,
              withIdempotency(idempotencyKey, opts),
            ),
          scheduleResponseSchema,
          'posts.schedule',
        ),
      cancelSchedule: async (postId, opts): Promise<{ cancelled: number }> => ({
        cancelled: normaliseCount(
          await transport.delete(`/posts/${postId}/schedule`, opts),
          'cancelled',
        ),
      }),
      publishes: (postId, opts) =>
        parse(
          () => transport.get(`/posts/${postId}/publishes`, opts),
          asArray(publishJobSchema),
          'posts.publishes',
        ),
      assets: (postId, opts) => transport.get(`/posts/${postId}/assets`, opts),
    },

    jobs: {
      detail: (jobId, opts) =>
        parse(() => transport.get(`/jobs/${jobId}`, opts), jobSchema, 'jobs.detail'),
    },

    assets: {
      requestUpload: (body, opts) =>
        parse(
          () => transport.post('/assets/uploads', body, opts),
          presignedUploadSchema,
          'assets.upload',
        ),
      confirm: (assetId, opts) => transport.post(`/assets/${assetId}/confirm`, undefined, opts),
    },

    socialAccounts: {
      list: (workspaceId, opts) =>
        parse(
          () => transport.get('/social-accounts', { ...opts, query: { workspaceId } }),
          asArray(socialAccountSchema),
          'socialAccounts.list',
        ),
      connect: (body, opts) =>
        parse(
          () => transport.post('/social-accounts', body, opts),
          socialAccountSchema,
          'socialAccounts.connect',
        ),
      disconnect: (accountId, opts): Promise<{ disconnected: boolean }> =>
        transport.delete(`/social-accounts/${accountId}`, opts),
    },

    notifications: {
      list: (unreadOnly = false, opts) =>
        parse(
          () => transport.get('/notifications', { ...opts, query: { unread: unreadOnly } }),
          asArray(notificationSchema),
          'notifications.list',
        ),
      unreadCount: async (opts) =>
        normaliseCount(await transport.get('/notifications/unread-count', opts), 'count'),
      markRead: (notificationId, opts): Promise<{ updated: boolean }> =>
        transport.post(`/notifications/${notificationId}/read`, undefined, opts),
      markAllRead: (opts): Promise<{ updated: number }> =>
        transport.post('/notifications/read-all', undefined, opts),
    },
  };
}

/**
 * Accepts either a bare array or `{ items: [...] }`.
 *
 * Some list endpoints return one and some the other. Normalising here means the
 * components do not have to know which, and adding a wrapper upstream is a
 * non-event rather than a crash in three screens.
 */
function asArray<S extends z.ZodType>(schema: S): z.ZodType<z.infer<S>[]> {
  return z.preprocess((raw: unknown): unknown => {
    if (Array.isArray(raw)) {
      return raw;
    }

    // Narrowed through `Array.isArray` rather than an assertion, so the return
    // type is `unknown[]` and not `any[]`. `in` already narrows to
    // `object & Record<'items', unknown>`, so no cast is needed either.
    if (typeof raw === 'object' && raw !== null && 'items' in raw && Array.isArray(raw.items)) {
      return raw.items;
    }

    return raw;
  }, schema.array());
}

/** `{ count: 3 }` and a bare `3` both mean three. */
function normaliseCount(raw: unknown, key: string): number {
  if (typeof raw === 'number') {
    return raw;
  }

  if (typeof raw === 'object' && raw !== null) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number') {
      return value;
    }
  }

  return 0;
}

function withIdempotency(
  key: string | undefined,
  opts: RequestOptions | undefined,
): RequestOptions {
  if (key === undefined) {
    return opts ?? {};
  }

  return {
    ...opts,
    headers: { ...opts?.headers, 'Idempotency-Key': key },
  };
}

export { ApiClientError };
export type {
  AuthResponse,
  Brand,
  Campaign,
  ConnectAccountRequest,
  CreditsResponse,
  GenerateRequest,
  GenerateResponse,
  Job,
  MeResponse,
  Notification,
  Post,
  PublishJob,
  ScheduleRequest,
  ScheduleResponse,
  SocialAccount,
  Workspace,
};

export {
  connectAccountRequestSchema,
  createBrandRequestSchema,
  createCampaignRequestSchema,
  createPostRequestSchema,
  generateRequestSchema,
  scheduleRequestSchema,
  updatePostRequestSchema,
};
