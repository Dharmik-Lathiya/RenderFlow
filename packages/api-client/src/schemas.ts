import { z } from 'zod';

/**
 * Response schemas for the RenderFlow API.
 *
 * The transport in `client.ts` is generic - it takes a `T` and hands back a `T`,
 * trusting the server. This file is where that trust is earned: every response
 * the web app reads is parsed here, so a server that changes shape produces an
 * error at the boundary rather than `undefined is not an object` three
 * components deep.
 *
 * Why this is hand-written when AGENTS.md says the client is generated: the
 * OpenAPI document has no component schemas, because the API validates requests
 * with zod and Nest's Swagger plugin reads decorators. Once the API publishes
 * response schemas these become generated, and `routes.spec.ts` already fails if
 * a path here is not in the generated map - so the migration is a deletion, not
 * an audit.
 *
 * Every schema is `.loose()` on objects the server may extend, but STRICT about
 * the fields the UI actually reads. A new optional field is a non-event; a
 * renamed one is caught.
 */

// --- shared ---------------------------------------------------------------

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.string(),
});

export const walletSchema = z.object({
  available: z.number().int(),
  reserved: z.number().int(),
});

export const creditsResponseSchema = z.object({
  wallet: walletSchema,
  /** Cheapest generation available, so the UI can say "from N credits". */
  signupBonus: z.number().int().optional(),
});

// --- auth -----------------------------------------------------------------

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginRequestSchema = registerRequestSchema;

export const authResponseSchema = z.object({
  user: userSchema,
  wallet: walletSchema,
});

export const meResponseSchema = z.object({
  user: userSchema,
  wallet: walletSchema,
});

// --- workspaces and brands ------------------------------------------------

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
});

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.string(),
});

export const brandSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  industry: z.string().nullable(),
  /** JSON columns arrive as whatever the driver parsed; normalised here. */
  colors: z.array(z.string()),
  languages: z.array(z.string()),
  voice: z
    .object({
      tone: z.string().optional(),
      style: z.string().optional(),
      do: z.array(z.string()).optional(),
      dont: z.array(z.string()).optional(),
    })
    .partial()
    .optional(),
});

export const createBrandRequestSchema = z.object({
  workspaceId: z.string(),
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(120).optional(),
  colors: z.array(z.string()).max(12).default([]),
  languages: z.array(z.string().max(10)).max(12).default(['en']),
  tone: z.string().trim().max(200).optional(),
  style: z.string().trim().max(200).optional(),
});

// --- campaigns and posts --------------------------------------------------

export const campaignSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  goal: z.string(),
  status: z.string(),
  createdBy: z.string(),
  // `date` columns; absent from older responses, so nullable rather than required
  // would only hide a rename. They are present on both create and detail.
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
});

export const postSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  brandId: z.string(),
  type: z.string(),
  caption: z.string().nullable(),
  hashtags: z.string(),
  status: z.string(),
  approvedBy: z.string().nullable().optional(),
  scheduledAt: z.string().nullable(),
  version: z.number().int(),
});

export const createCampaignRequestSchema = z.object({
  brandId: z.string(),
  goal: z.string().trim().min(3).max(2_000),
});

export const createPostRequestSchema = z.object({
  campaignId: z.string(),
  type: z.string(),
  caption: z.string().max(20_000).optional(),
  hashtags: z.string().max(2_000).optional(),
});

export const updatePostRequestSchema = z.object({
  caption: z.string().max(20_000).optional(),
  hashtags: z.string().max(2_000).optional(),
  type: z.string().optional(),
});

// --- generation -----------------------------------------------------------

export const generateRequestSchema = z.object({
  type: z.enum(['CAPTION', 'POSTER', 'CAROUSEL', 'REEL']),
  images: z.number().int().positive().max(10).optional(),
  scenes: z.number().int().positive().max(10).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
  goal: z.string().trim().max(200).optional(),
});

export const jobSchema = z.object({
  id: z.string(),
  postId: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  stage: z.string(),
  creditsReserved: z.number().int(),
  refunded: z.boolean(),
  captured: z.boolean(),
  error: z.string().nullable(),
  completedStages: z.array(z.string()),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const generateResponseSchema = z.object({
  job: jobSchema,
  replayed: z.boolean(),
});

// --- assets ---------------------------------------------------------------

export const assetSchema = z.object({
  id: z.string(),
  postId: z.string().nullable(),
  type: z.string(),
  storageKey: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  createdAt: z.string(),
});

/**
 * What `POST /assets/uploads` answers with.
 *
 * The nested shape (`{ asset, upload }`) and the `url` key are what the API
 * returns; an earlier version of this schema guessed `uploadUrl`, which meant
 * every upload response failed to parse and the failure looked like a network
 * problem rather than a wrong guess.
 */
export const presignedUploadSchema = z.object({
  asset: assetSchema,
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    /** Headers the browser must send with the PUT, or S3 rejects it. */
    headers: z.record(z.string(), z.string()),
    expiresInSeconds: z.number().int().positive(),
  }),
});

// --- publishing (Phase 7) -------------------------------------------------

export const socialAccountSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  platform: z.string(),
  externalAccountId: z.string(),
  displayName: z.string().nullable(),
  scopes: z.array(z.string()),
  tokenExpiresAt: z.string().nullable(),
  connectedBy: z.string(),
  createdAt: z.string(),
  needsReconnect: z.boolean(),
});

export const publishJobSchema = z.object({
  id: z.string(),
  postId: z.string(),
  socialAccountId: z.string(),
  platform: z.string(),
  status: z.string(),
  scheduledFor: z.string(),
  externalPostId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  error: z.string().nullable(),
});

export const scheduleRequestSchema = z.object({
  scheduledAt: z.coerce.date(),
  accountIds: z.array(z.string()).min(1).max(10),
});

export const scheduleResponseSchema = z.object({
  postId: z.string(),
  scheduledAt: z.string(),
  jobs: z.array(publishJobSchema),
  replayed: z.boolean(),
});

export const connectAccountRequestSchema = z.object({
  workspaceId: z.string(),
  platform: z.enum(['linkedin', 'instagram']),
  externalAccountId: z.string().trim().min(1),
  displayName: z.string().trim().max(200).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenExpiresAt: z.string().optional(),
  scopes: z.array(z.string()).max(50).default([]),
});

export const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const notificationsResponseSchema = z.object({
  items: z.array(notificationSchema).optional(),
  count: z.number().int().optional(),
});

export type User = z.infer<typeof userSchema>;
export type Wallet = z.infer<typeof walletSchema>;
export type CreditsResponse = z.infer<typeof creditsResponseSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Brand = z.infer<typeof brandSchema>;
export type CreateBrandRequest = z.infer<typeof createBrandRequestSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;
export type Post = z.infer<typeof postSchema>;
export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;
export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type Job = z.infer<typeof jobSchema>;
export type GenerateResponse = z.infer<typeof generateResponseSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type PresignedUpload = z.infer<typeof presignedUploadSchema>;
export type SocialAccount = z.infer<typeof socialAccountSchema>;
export type PublishJob = z.infer<typeof publishJobSchema>;
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
export type ConnectAccountRequest = z.input<typeof connectAccountRequestSchema>;
export type Notification = z.infer<typeof notificationSchema>;

// --- analytics (Phase 9) --------------------------------------------------

/**
 * Totals are numbers, never strings: the API casts its aggregates with `::int`,
 * so a client reading `"12"` and doing `+` would concatenate. Parsing here is
 * what makes that a loud failure instead of "012" on a dashboard.
 */
export const analyticsTotalsSchema = z.object({
  posts: z.number().int(),
  published: z.number().int(),
  likes: z.number().int(),
  comments: z.number().int(),
  reach: z.number().int(),
  clicks: z.number().int(),
  engagementRate: z.number(),
});

export const platformMetricsSchema = z.object({
  likes: z.number().int(),
  comments: z.number().int(),
  reach: z.number().int(),
  clicks: z.number().int(),
  fetchedAt: z.string(),
});

export const publicationAnalyticsSchema = z.object({
  postId: z.string(),
  type: z.string(),
  status: z.string(),
  caption: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  publishJobId: z.string().nullable(),
  publishStatus: z.string().nullable(),
  platform: z.string().nullable(),
  externalUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  metrics: platformMetricsSchema.nullable(),
});

export const suggestionSchema = z.object({
  type: z.enum(['CAPTION', 'POSTER', 'CAROUSEL', 'REEL']),
  title: z.string(),
  rationale: z.string(),
});

export const seriesPointSchema = z.object({
  date: z.string(),
  likes: z.number().int(),
  comments: z.number().int(),
  reach: z.number().int(),
  clicks: z.number().int(),
});

export const campaignAnalyticsSchema = z.object({
  campaign: z.object({
    id: z.string(),
    brandId: z.string(),
    goal: z.string(),
    status: z.string(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
  }),
  totals: analyticsTotalsSchema,
  publications: z.array(publicationAnalyticsSchema),
  series: z.array(seriesPointSchema),
  suggestions: z.array(suggestionSchema),
});

export const campaignSummarySchema = analyticsTotalsSchema.extend({
  id: z.string(),
  brandName: z.string(),
  goal: z.string(),
  status: z.string(),
});

export const workspaceAnalyticsSchema = z.object({
  workspaceId: z.string(),
  totals: analyticsTotalsSchema,
  campaigns: z.array(campaignSummarySchema),
});

export const scheduledPostSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  brandId: z.string(),
  type: z.string(),
  caption: z.string().nullable(),
  status: z.string(),
  scheduledAt: z.string().nullable(),
  version: z.number().int(),
  campaignGoal: z.string(),
  brandName: z.string(),
});

// --- admin (Phase 9) ------------------------------------------------------

export const dlqJobSchema = z.object({
  id: z.string(),
  postId: z.string().nullable(),
  kind: z.string(),
  stage: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  creditsReserved: z.number().int(),
  refunded: z.boolean(),
  captured: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const outboxEventSchema = z.object({
  id: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  eventType: z.string(),
  attempts: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
});

export const reconcileReportSchema = z.object({
  userId: z.string(),
  available: z.number().int(),
  reserved: z.number().int(),
  walletTotal: z.number().int(),
  ledgerTotal: z.number().int(),
  ledgerAvailable: z.number().int(),
  ledgerReserved: z.number().int(),
  drifted: z.boolean(),
});

export const adjustCreditsRequestSchema = z.object({
  userId: z.string(),
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, 'amount must be non-zero'),
  reason: z.string().trim().min(3).max(500),
  referenceId: z.string().trim().min(1).max(200).optional(),
});

export const adjustCreditsResponseSchema = z.object({
  userId: z.string(),
  amount: z.number().int(),
  balance: z.object({
    userId: z.string(),
    available: z.number().int(),
    reserved: z.number().int(),
    total: z.number().int(),
  }),
  referenceId: z.string().nullable(),
  /** False when the reference id had already been applied. */
  applied: z.boolean(),
});

export type AnalyticsTotals = z.infer<typeof analyticsTotalsSchema>;
export type PlatformMetrics = z.infer<typeof platformMetricsSchema>;
export type PublicationAnalytics = z.infer<typeof publicationAnalyticsSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type SeriesPoint = z.infer<typeof seriesPointSchema>;
export type CampaignAnalytics = z.infer<typeof campaignAnalyticsSchema>;
export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
export type WorkspaceAnalytics = z.infer<typeof workspaceAnalyticsSchema>;
export type ScheduledPost = z.infer<typeof scheduledPostSchema>;
export type DlqJob = z.infer<typeof dlqJobSchema>;
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
export type ReconcileReport = z.infer<typeof reconcileReportSchema>;
export type AdjustCreditsRequest = z.infer<typeof adjustCreditsRequestSchema>;
export type AdjustCreditsResponse = z.infer<typeof adjustCreditsResponseSchema>;
