/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with:  pnpm openapi:generate
 * Source:           packages/api-client/openapi.json
 *
 * Hand edits are silently discarded by the next run.
 *
 * Every operation type carries an empty `request` and `response`, because the
 * document has no component schemas yet - the API validates with zod, which
 * Nest's Swagger plugin cannot read. They are here so that adding a schema later
 * fills them in, rather than changing every consumer's types.
 */
export interface ApiOperation {
  /** Present when the document carries a summary. */
  readonly summary: string | undefined;
  readonly pathParams: readonly { readonly name: string; readonly required: boolean }[];
  readonly query: readonly string[];
  readonly hasBody: boolean;
  /**
   * Typed only once the API publishes a response schema for this operation.
   * `unknown` today, and deliberately not `any`: a caller has to narrow it,
   * which is what stops an untyped response from spreading through the app.
   */
  readonly response: unknown;
  readonly request: unknown;
}

export type RouteMap = {
  readonly '/admin/credits/adjust': {
    readonly post: ApiOperation;
  };
  readonly '/admin/dlq': {
    readonly get: ApiOperation;
  };
  readonly '/admin/dlq/outbox': {
    readonly get: ApiOperation;
  };
  readonly '/admin/dlq/outbox/{eventId}/replay': {
    readonly post: ApiOperation;
  };
  readonly '/admin/dlq/{jobId}/replay': {
    readonly post: ApiOperation;
  };
  readonly '/admin/reconcile': {
    readonly get: ApiOperation;
  };
  readonly '/analytics/campaigns/{campaignId}': {
    readonly get: ApiOperation;
  };
  readonly '/analytics/overview': {
    readonly get: ApiOperation;
  };
  readonly '/assets/uploads': {
    readonly post: ApiOperation;
  };
  readonly '/assets/{assetId}': {
    readonly delete: ApiOperation;
  };
  readonly '/assets/{assetId}/confirm': {
    readonly post: ApiOperation;
  };
  readonly '/assets/{assetId}/download': {
    readonly get: ApiOperation;
  };
  readonly '/auth/forgot-password': {
    readonly post: ApiOperation;
  };
  readonly '/auth/login': {
    readonly post: ApiOperation;
  };
  readonly '/auth/logout': {
    readonly post: ApiOperation;
  };
  readonly '/auth/me': {
    readonly get: ApiOperation;
  };
  readonly '/auth/refresh': {
    readonly post: ApiOperation;
  };
  readonly '/auth/register': {
    readonly post: ApiOperation;
  };
  readonly '/auth/resend-verification': {
    readonly post: ApiOperation;
  };
  readonly '/auth/reset-password': {
    readonly post: ApiOperation;
  };
  readonly '/auth/verify-email': {
    readonly post: ApiOperation;
  };
  readonly '/brands': {
    readonly get: ApiOperation;
    readonly post: ApiOperation;
  };
  readonly '/brands/{brandId}': {
    readonly get: ApiOperation;
    readonly patch: ApiOperation;
    readonly delete: ApiOperation;
  };
  readonly '/brands/{brandId}/campaigns': {
    readonly get: ApiOperation;
  };
  readonly '/campaigns': {
    readonly post: ApiOperation;
  };
  readonly '/campaigns/{campaignId}': {
    readonly get: ApiOperation;
  };
  readonly '/campaigns/{campaignId}/posts': {
    readonly get: ApiOperation;
  };
  readonly '/credits': {
    readonly get: ApiOperation;
  };
  readonly '/credits/pricing': {
    readonly get: ApiOperation;
  };
  readonly '/credits/top-up': {
    readonly post: ApiOperation;
  };
  readonly '/docs-json': {
    readonly get: ApiOperation;
  };
  readonly '/health/live': {
    readonly get: ApiOperation;
  };
  readonly '/health/ready': {
    readonly get: ApiOperation;
  };
  readonly '/jobs/{jobId}': {
    readonly get: ApiOperation;
  };
  readonly '/jobs/{jobId}/events': {
    readonly get: ApiOperation;
  };
  readonly '/me': {
    readonly get: ApiOperation;
  };
  readonly '/metrics': {
    readonly get: ApiOperation;
  };
  readonly '/notifications': {
    readonly get: ApiOperation;
  };
  readonly '/notifications/read-all': {
    readonly post: ApiOperation;
  };
  readonly '/notifications/unread-count': {
    readonly get: ApiOperation;
  };
  readonly '/notifications/{notificationId}/read': {
    readonly post: ApiOperation;
  };
  readonly '/posts': {
    readonly get: ApiOperation;
    readonly post: ApiOperation;
  };
  readonly '/posts/{postId}': {
    readonly get: ApiOperation;
    readonly patch: ApiOperation;
  };
  readonly '/posts/{postId}/approve': {
    readonly post: ApiOperation;
  };
  readonly '/posts/{postId}/assets': {
    readonly get: ApiOperation;
  };
  readonly '/posts/{postId}/generate': {
    readonly post: ApiOperation;
  };
  readonly '/posts/{postId}/publishes': {
    readonly get: ApiOperation;
  };
  readonly '/posts/{postId}/schedule': {
    readonly post: ApiOperation;
    readonly patch: ApiOperation;
    readonly delete: ApiOperation;
  };
  readonly '/social-accounts': {
    readonly get: ApiOperation;
    readonly post: ApiOperation;
  };
  readonly '/social-accounts/{accountId}': {
    readonly delete: ApiOperation;
  };
  readonly '/workspaces': {
    readonly get: ApiOperation;
  };
  readonly '/workspaces/{workspaceId}': {
    readonly get: ApiOperation;
  };
  readonly '/workspaces/{workspaceId}/members': {
    readonly get: ApiOperation;
    readonly post: ApiOperation;
  };
  readonly '/workspaces/{workspaceId}/members/{userId}': {
    readonly delete: ApiOperation;
  };
};

/** Every documented path, for the drift test in `routes.spec.ts`. */
export const ROUTE_PATHS = [
  '/admin/credits/adjust',
  '/admin/dlq',
  '/admin/dlq/outbox',
  '/admin/dlq/outbox/{eventId}/replay',
  '/admin/dlq/{jobId}/replay',
  '/admin/reconcile',
  '/analytics/campaigns/{campaignId}',
  '/analytics/overview',
  '/assets/uploads',
  '/assets/{assetId}',
  '/assets/{assetId}/confirm',
  '/assets/{assetId}/download',
  '/auth/forgot-password',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/refresh',
  '/auth/register',
  '/auth/resend-verification',
  '/auth/reset-password',
  '/auth/verify-email',
  '/brands',
  '/brands/{brandId}',
  '/brands/{brandId}/campaigns',
  '/campaigns',
  '/campaigns/{campaignId}',
  '/campaigns/{campaignId}/posts',
  '/credits',
  '/credits/pricing',
  '/credits/top-up',
  '/docs-json',
  '/health/live',
  '/health/ready',
  '/jobs/{jobId}',
  '/jobs/{jobId}/events',
  '/me',
  '/metrics',
  '/notifications',
  '/notifications/read-all',
  '/notifications/unread-count',
  '/notifications/{notificationId}/read',
  '/posts',
  '/posts/{postId}',
  '/posts/{postId}/approve',
  '/posts/{postId}/assets',
  '/posts/{postId}/generate',
  '/posts/{postId}/publishes',
  '/posts/{postId}/schedule',
  '/social-accounts',
  '/social-accounts/{accountId}',
  '/workspaces',
  '/workspaces/{workspaceId}',
  '/workspaces/{workspaceId}/members',
  '/workspaces/{workspaceId}/members/{userId}',
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];

export const ROUTES: RouteMap = {
  '/admin/credits/adjust': {
    post: {
      summary: 'Grant or remove credits, audited',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/admin/dlq': {
    get: {
      summary: 'Jobs that exhausted their attempts and were refunded',
      pathParams: [],
      query: ['limit'],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/admin/dlq/outbox': {
    get: {
      summary: 'Outbox events the relay gave up on',
      pathParams: [],
      query: ['limit'],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/admin/dlq/outbox/{eventId}/replay': {
    post: {
      summary: 'Put an abandoned event back in the pending set',
      pathParams: [{ name: 'eventId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/admin/dlq/{jobId}/replay': {
    post: {
      summary: 'Re-reserve and re-queue a failed job',
      pathParams: [{ name: 'jobId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/admin/reconcile': {
    get: {
      summary: 'Per-bucket wallet/ledger reconciliation',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/analytics/campaigns/{campaignId}': {
    get: {
      summary: 'Totals, latest per-publication metrics, a daily series and next-post suggestions',
      pathParams: [{ name: 'campaignId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/analytics/overview': {
    get: {
      summary: 'Workspace-wide totals, by campaign',
      pathParams: [],
      query: ['workspaceId'],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/assets/uploads': {
    post: {
      summary: 'Create an asset record and get a presigned upload URL',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/assets/{assetId}': {
    delete: {
      summary: 'Delete an asset',
      pathParams: [{ name: 'assetId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/assets/{assetId}/confirm': {
    post: {
      summary: 'Confirm an upload by reading the real object size back',
      pathParams: [{ name: 'assetId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/assets/{assetId}/download': {
    get: {
      summary: 'Get a short-lived presigned download URL',
      pathParams: [{ name: 'assetId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/forgot-password': {
    post: {
      summary: 'Send a password reset link (always 202)',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/login': {
    post: {
      summary: 'Exchange credentials for a session',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/logout': {
    post: {
      summary: 'Revoke the presented session',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/me': {
    get: {
      summary: "The signed-in user's profile and wallet",
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/refresh': {
    post: {
      summary: 'Rotate the refresh token and issue a new access token',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/register': {
    post: {
      summary: 'Create an account and grant the signup bonus',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/resend-verification': {
    post: {
      summary: 'Re-send the email verification link',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/reset-password': {
    post: {
      summary: 'Set a new password using a reset token',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/auth/verify-email': {
    post: {
      summary: 'Confirm an email address with a verification token',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/brands': {
    get: {
      summary: 'List brands in a workspace',
      pathParams: [],
      query: ['workspaceId'],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    post: {
      summary: 'Create a brand (EDITOR+)',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/brands/{brandId}': {
    get: {
      summary: 'Fetch a brand',
      pathParams: [{ name: 'brandId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    patch: {
      summary: 'Update a brand (EDITOR+)',
      pathParams: [{ name: 'brandId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    delete: {
      summary: 'Delete a brand (OWNER only)',
      pathParams: [{ name: 'brandId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/brands/{brandId}/campaigns': {
    get: {
      summary: 'List campaigns for a brand',
      pathParams: [{ name: 'brandId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/campaigns': {
    post: {
      summary: 'Create a campaign (EDITOR+)',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/campaigns/{campaignId}': {
    get: {
      summary: 'Fetch one campaign',
      pathParams: [{ name: 'campaignId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/campaigns/{campaignId}/posts': {
    get: {
      summary: 'List posts in a campaign',
      pathParams: [{ name: 'campaignId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/credits': {
    get: {
      summary: 'Wallet balance and paginated credit ledger',
      pathParams: [],
      query: ['page', 'pageSize'],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/credits/pricing': {
    get: {
      summary: 'Active credit prices and the signup bonus',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/credits/top-up': {
    post: {
      summary: 'Buy a credit pack (stub provider; disabled by default)',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/docs-json': {
    get: {
      summary: 'The OpenAPI 3 document for this API',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/health/live': {
    get: {
      summary: 'Liveness: the process is up',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/health/ready': {
    get: {
      summary: 'Readiness: dependencies are reachable',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/jobs/{jobId}': {
    get: {
      summary: 'Job status and completed stages',
      pathParams: [{ name: 'jobId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/jobs/{jobId}/events': {
    get: {
      summary: 'Server-sent progress events for a job',
      pathParams: [{ name: 'jobId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/me': {
    get: {
      summary: 'The authenticated user profile',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/metrics': {
    get: {
      summary: 'Prometheus metrics',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/notifications': {
    get: {
      summary: 'My notifications, newest first',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/notifications/read-all': {
    post: {
      summary: 'Mark every notification read',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/notifications/unread-count': {
    get: {
      summary: 'How many notifications are unread',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/notifications/{notificationId}/read': {
    post: {
      summary: 'Mark one notification read',
      pathParams: [{ name: 'notificationId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts': {
    get: {
      summary: 'Scheduled posts across a workspace, for the calendar',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    post: {
      summary: 'Create a post (EDITOR+)',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}': {
    get: {
      summary: 'Read one post',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    patch: {
      summary: 'Edit a post; increments its version (EDITOR+)',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}/approve': {
    post: {
      summary: 'Approve a post (APPROVER+)',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}/assets': {
    get: {
      summary: "List a post's assets",
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}/generate': {
    post: {
      summary: 'Create a generation job; reserves credits in the same transaction',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}/publishes': {
    get: {
      summary: 'The publish history for a post',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/posts/{postId}/schedule': {
    post: {
      summary: 'Schedule an approved post to one or more connected accounts',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    patch: {
      summary: 'Move a scheduled post to a new time (APPROVER+)',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    delete: {
      summary: 'Cancel everything still pending for a post',
      pathParams: [{ name: 'postId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/social-accounts': {
    get: {
      summary: 'List the accounts a workspace publishes to',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    post: {
      summary: 'Connect a social account, or rotate its token',
      pathParams: [],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/social-accounts/{accountId}': {
    delete: {
      summary: 'Disconnect an account',
      pathParams: [{ name: 'accountId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/workspaces': {
    get: {
      summary: 'List the workspaces I belong to',
      pathParams: [],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/workspaces/{workspaceId}': {
    get: {
      summary: 'Fetch a workspace I am a member of',
      pathParams: [{ name: 'workspaceId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/workspaces/{workspaceId}/members': {
    get: {
      summary: 'List members (any member may read this)',
      pathParams: [{ name: 'workspaceId', required: true }],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
    post: {
      summary: 'Add or re-role a member (OWNER only)',
      pathParams: [{ name: 'workspaceId', required: true }],
      query: [],
      hasBody: true,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
  '/workspaces/{workspaceId}/members/{userId}': {
    delete: {
      summary: 'Remove a member (OWNER only; never the last owner)',
      pathParams: [
        { name: 'workspaceId', required: true },
        { name: 'userId', required: true },
      ],
      query: [],
      hasBody: false,
      response: undefined as unknown,
      request: undefined as unknown,
    },
  },
};
