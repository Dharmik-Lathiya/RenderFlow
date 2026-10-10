import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * RenderFlow database schema (PROJECT.md section 6).
 *
 * Phases 1 (auth, wallet, signup bonus) and 2 (pricing, generation jobs,
 * outbox). Later phases add workspaces, brands, campaigns, posts and assets.
 *
 * Every credit guarantee is declared HERE, in TypeScript, rather than in
 * hand-written migration SQL:
 *
 *   - `wallets_available_non_negative` / `wallets_reserved_non_negative`
 *     stop a balance from ever going negative (AGENTS.md rule 5);
 *   - `credit_ledger_signup_bonus_once` makes the signup bonus once-per-user;
 *   - `credit_ledger_reference_key` makes reserve/capture/refund idempotent
 *     (PROJECT.md section 5.10).
 *
 * These were partial/expression indexes under Prisma, which cannot express them,
 * so they lived in SQL that the migration tool could not diff or carry forward.
 * Drizzle keeps them in the same file as the columns they protect, so a schema
 * change cannot leave them behind.
 */

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['ADMIN', 'MEMBER']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercased before storage so case variants cannot create two accounts. */
    email: varchar('email', { length: 320 }).notNull(),
    /** argon2id hash. Never selected into a response object. */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    role: userRoleEnum('role').notNull().default('MEMBER'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // `$onUpdate` is the equivalent of Prisma's `@updatedAt`. Without it,
    // `updated_at` is set on INSERT only and silently goes stale on every UPDATE
    // - a bug that no type checker and no schema diff would ever surface.
    //
    // Caveat: `$onUpdate` runs in the application layer, so a raw SQL
    // `UPDATE` bypasses it. Every raw statement touching a row with an
    // `updated_at` column must therefore set `updated_at = now()` explicitly.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Named explicitly rather than via `.unique()` on the column: a column-level
    // unique produces an auto-named constraint, which then exists *in addition*
    // to this index. One named index, one name, stable across migrations.
    emailIdx: uniqueIndex('users_email_key').on(table.email),
  }),
);

// ---------------------------------------------------------------------------
// wallets
// ---------------------------------------------------------------------------

export const wallets = pgTable(
  'wallets',
  {
    /** One wallet per user; also the foreign key to users. */
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Credits the user may spend right now. */
    available: integer('available').notNull().default(0),
    /** Credits held against in-flight jobs: spent on capture, returned on refund. */
    reserved: integer('reserved').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // See the note on `users.updatedAt`: the credit engine updates wallets with
    // raw SQL, which bypasses `$onUpdate`, so those statements set this column
    // themselves.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // AGENTS.md rule 5. The database is the last line of defence: a buggy
    // balance write is rejected instead of silently trusted.
    availableNonNegative: check('wallets_available_non_negative', sql`${table.available} >= 0`),
    reservedNonNegative: check('wallets_reserved_non_negative', sql`${table.reserved} >= 0`),
  }),
);

// ---------------------------------------------------------------------------
// credit_ledger (append-only)
// ---------------------------------------------------------------------------

export const creditEntryTypeEnum = pgEnum('credit_entry_type', [
  'SIGNUP_BONUS',
  'PURCHASE',
  'RESERVE',
  'CAPTURE',
  'REFUND',
  'ADJUSTMENT',
  'EXPIRY',
]);

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    entryType: creditEntryTypeEnum('entry_type').notNull(),
    /**
     * Signed: grants are positive, RESERVE/CAPTURE are negative. Credits are
     * integers only, which is what keeps SUM(ledger) exactly equal to
     * available + reserved.
     */
    amount: integer('amount').notNull(),

    /**
     * Idempotency scope. SYSTEM entries have no reference; the partial unique
     * index below makes those unique per user instead.
     */
    referenceType: varchar('reference_type', { length: 40 }),
    referenceId: varchar('reference_id', { length: 64 }),

    /** Operator note. Never contains secrets. */
    note: varchar('note', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    // PROJECT.md section 5.10: idempotency key for reserve/capture/refund.
    // Partial so SYSTEM entries (reference_type IS NULL) are unaffected - NULLs
    // do not collide in a unique index anyway, and being explicit keeps the
    // intent readable.
    referenceKey: uniqueIndex('credit_ledger_reference_key')
      .on(table.referenceType, table.referenceId, table.entryType)
      .where(sql`${table.referenceType} IS NOT NULL`),

    // PROJECT.md section 5.1 rule 1: the signup bonus is granted exactly once
    // per user. Partial rather than unique on (user_id, entry_type), because a
    // user may legitimately have many RESERVE rows.
    signupBonusOnce: uniqueIndex('credit_ledger_signup_bonus_once')
      .on(table.userId)
      .where(sql`${table.entryType} = 'SIGNUP_BONUS'`),

    userCreatedIdx: index('credit_ledger_user_id_created_at_idx').on(
      table.userId,
      table.createdAt.desc(),
    ),
  }),
);

// ---------------------------------------------------------------------------
// refresh_sessions
// ---------------------------------------------------------------------------

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * SHA-256 of the refresh token, hex encoded. The plaintext only ever exists
     * in the httpOnly cookie, so a database leak yields no usable session.
     *
     * `varchar(64)` rather than `char(64)`: a fixed-width CHAR is blank-padded,
     * which changes comparison and trimming semantics for no benefit. A hex
     * digest is always exactly 64 characters.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),

    userAgent: varchar('user_agent', { length: 255 }),
    ipAddress: varchar('ip_address', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex('refresh_sessions_token_hash_key').on(table.tokenHash),
    userIdx: index('refresh_sessions_user_id_idx').on(table.userId),
    expiresIdx: index('refresh_sessions_expires_at_idx').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// pricing_rules
// ---------------------------------------------------------------------------

/**
 * Server-side prices (PROJECT.md section 5.2, AGENTS.md rule 7: "Costs come from
 * the server, never from the client").
 *
 * A row per billable action rather than a constant in code, so a price change is
 * a data change and an audit of what a user was charged is a query, not a
 * archaeology exercise through git.
 */
export const pricingRules = pgTable(
  'pricing_rules',
  {
    /** Matches `GENERATION_KINDS`; the key is what a job stores. */
    action: varchar('action', { length: 40 }).primaryKey(),
    /** Integer credits. Never a float (AGENTS.md section 7). */
    credits: integer('credits').notNull(),
    /**
     * Inactive rules stay for historical pricing: a job captured last month must
     * still reconcile against the rate that was in force then.
     */
    active: integer('active').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // A price of zero is legitimate (a free action), a negative one is not: it
    // would let a "cost" mint credits.
    nonNegative: check('pricing_rules_credits_non_negative', sql`${table.credits} >= 0`),
    activeIdx: index('pricing_rules_active_idx').on(table.active),
  }),
);

// ---------------------------------------------------------------------------
// generation_jobs
// ---------------------------------------------------------------------------

export const jobStatusEnum = pgEnum('job_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const jobStageEnum = pgEnum('job_stage', [
  'PLAN',
  'SCRIPT',
  'IMAGE',
  'VOICE',
  'RENDER',
  'DONE',
]);

/**
 * A generation job and its credit reservation.
 *
 * The job row is what makes reserve/capture/refund safe under retries: the
 * `refunded` flag and the status guard are the atomic test-and-set that stops a
 * reaper and a worker refunding the same job twice (PROJECT.md section 5.5,
 * test C8). The credit movement itself lives in `libs/credits`; this table is
 * the state it is guarded by.
 */
export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null until Phase 3 introduces campaigns and posts. */
    postId: uuid('post_id'),

    kind: varchar('kind', { length: 40 }).notNull(),
    status: jobStatusEnum('status').notNull().default('PENDING'),
    stage: jobStageEnum('stage').notNull().default('PLAN'),

    /** Credits moved available -> reserved by the creating transaction. */
    creditsReserved: integer('credits_reserved').notNull(),
    /**
     * Set true by the refund path, atomically with the wallet update.
     *
     * This is the idempotency guarantee for C8: `WHERE refunded = false` means
     * only one caller can ever win the refund, however many race.
     */
    refunded: integer('refunded').notNull().default(0),
    /** Set true by the capture path; a refunded job can never be captured. */
    captured: integer('captured').notNull().default(0),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

    // Lease fields. The reaper reclaims a job whose worker died without
    // finishing (PROJECT.md section 9, chaos test R-series).
    workerId: varchar('worker_id', { length: 100 }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),

    /**
     * Client-supplied idempotency key (PROJECT.md section 9.5, test C10).
     *
     * Scoped to the user, not global: two users legitimately picking the same
     * key must not collide, and a key is not a secret so it is safe to store.
     */
    idempotencyKey: varchar('idempotency_key', { length: 200 }),

    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // C10: one job per (user, idempotency key). The unique index is the whole
    // mechanism - a replayed request collides here rather than charging twice.
    userIdempotencyKey: uniqueIndex('generation_jobs_user_idempotency_key')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),

    // Partial, so a job with no key (an internally created one) does not collide
    // with any other keyless job.
    // The reaper's queue poll: "unfinished jobs whose lease has expired".
    reclaimIdx: index('generation_jobs_reclaim_idx')
      .on(table.status, table.lockedUntil)
      .where(sql`${table.status} IN ('PENDING','PROCESSING')`),

    nonNegativeCosts: check(
      'generation_jobs_credits_non_negative',
      sql`${table.creditsReserved} >= 0`,
    ),
    nonNegativeAttempts: check(
      'generation_jobs_attempts_non_negative',
      sql`${table.attempts} >= 0`,
    ),

    // A job cannot be both captured and refunded: it either cost the user the
    // credits or it did not. Without this the terminal-state race in C9 could
    // settle either way and neither path would notice.
    notCapturedAndRefunded: check(
      'generation_jobs_not_captured_and_refunded',
      sql`NOT (${table.captured} = 1 AND ${table.refunded} = 1)`,
    ),

    userCreatedIdx: index('generation_jobs_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// workspaces and membership
// ---------------------------------------------------------------------------

export const workspaceRoleEnum = pgEnum('workspace_role', [
  'OWNER',
  'EDITOR',
  'APPROVER',
  'VIEWER',
]);

/**
 * The tenancy boundary.
 *
 * Every brand, campaign, post and asset hangs off a workspace, and every query
 * for one filters by the caller's membership in it. That is the multi-tenant
 * isolation requirement (AGENTS.md section 10), and it is why `workspace_id`
 * appears on each table rather than being inferred through a join.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    /** The user who created it; always also an OWNER member. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    notBlank: check('workspaces_name_not_blank', sql`length(btrim(${table.name})) > 0`),
  }),
);

/**
 * Membership, and the single source of truth for what a user may do in a
 * workspace.
 *
 * The composite primary key makes membership unique per (workspace, user) by
 * construction, so there is no window in which a user can hold two roles.
 *
 * Declared through `primaryKey({ columns })` rather than `.primaryKey()` on both
 * columns: the latter marks each column primary on its own, which Postgres
 * rejects, and omitting it entirely leaves the table with no key at all - so a
 * user could be added twice and `ON CONFLICT (workspace_id, user_id)` would
 * fail with "no unique or exclusion constraint matching the ON CONFLICT".
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceUserPk: primaryKey({
      name: 'workspace_members_pkey',
      columns: [table.workspaceId, table.userId],
    }),
    // "which workspaces am I in", the question every scoped query starts from.
    userIdx: index('workspace_members_user_id_idx').on(table.userId),
  }),
);

// ---------------------------------------------------------------------------
// brands, campaigns, posts, assets
// ---------------------------------------------------------------------------

/**
 * A brand: the voice and visual identity content is generated against.
 *
 * `colors` and `languages` are jsonb / text[] rather than child tables because
 * they are always read and written whole, never queried across brands. A
 * normalised colour table would buy nothing at this scale.
 *
 * Both defaults are written as explicit SQL. Passing `.default([])` makes
 * drizzle-kit emit an empty `DEFAULT` for the array column, producing
 * `"languages" text DEFAULT NOT NULL` - a syntax error that fails the migration
 * rather than doing anything visible.
 */
export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    industry: varchar('industry', { length: 120 }),
    /** Free text describing the writing voice; injected into prompts. */
    tone: text('tone'),
    audience: text('audience'),
    /** Hex colours, validated as `#rrggbb` before they are stored. */
    colors: jsonb('colors')
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** BCP-47-ish language tags, e.g. `en`, `hi`. */
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** FK to assets is added after `assets` exists, to avoid a cycle. */
    logoAssetId: uuid('logo_asset_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Brand names are unique within a workspace, not globally: two companies may
    // both have a brand called "Spring".
    workspaceNameIdx: uniqueIndex('brands_workspace_id_name_key').on(table.workspaceId, table.name),
  }),
);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'PLANNING',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
]);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Free text; the AI planner turns this into a content plan. */
    goal: text('goal').notNull(),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),
    // Calendar dates, not instants: a campaign runs for days and has no time of
    // day, so a timestamp implies precision that does not exist and makes
    // off-by-one-day comparisons easy to get wrong.
    //
    // `mode: 'string'` keeps the value as the `YYYY-MM-DD` the API sends.
    // Inserting still goes through a SQL cast - see `createCampaign`.
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    brandIdx: index('campaigns_brand_id_idx').on(table.brandId),
    // An end date before the start date is always a mistake, and a CHECK is the
    // only place it can be refused for every writer.
    dateOrder: check(
      'campaigns_date_order',
      sql`${table.startDate} IS NULL OR ${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
  }),
);

export const postStatusEnum = pgEnum('post_status', [
  'DRAFT',
  'GENERATING',
  'READY',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
]);

/**
 * A single piece of content.
 *
 * `version` is incremented on every edit: the publish path and the SSE stream
 * both key off it so a client can tell a stale render from a current one.
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** Denormalised from the campaign so brand queries never need the join. */
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 20 }).notNull(),
    caption: text('caption'),
    hashtags: text('hashtags').notNull().default(''),
    status: postStatusEnum('status').notNull().default('DRAFT'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    campaignIdx: index('posts_campaign_id_idx').on(table.campaignId),
    brandIdx: index('posts_brand_id_idx').on(table.brandId),
    versionPositive: check('posts_version_positive', sql`${table.version} >= 1`),
  }),
);

/**
 * A stored file: an uploaded image, a generated reel, a caption translation.
 *
 * `size_bytes` is not in PROJECT.md section 6's sketch but is required to enforce
 * the upload size limit (AGENTS.md section 10) before a presigned PUT is issued -
 * without it the server cannot refuse an oversized upload, because the client
 * streams the bytes straight to S3.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for a workspace-level asset such as a brand logo. */
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 20 }).notNull(),
    storageKey: varchar('storage_key', { length: 400 }).notNull(),
    mime: varchar('mime', { length: 120 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    postIdx: index('assets_post_id_idx').on(table.postId),
    workspaceIdx: index('assets_workspace_id_idx').on(table.workspaceId),
    // Two assets cannot share an object key: the same key would be uploaded
    // twice and the first write silently win.
    storageKeyIdx: uniqueIndex('assets_storage_key_key').on(table.storageKey),
    sizePositive: check('assets_size_bytes_positive', sql`${table.sizeBytes} >= 0`),
    dimensionsSane: check(
      'assets_dimensions_sane',
      sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// outbox_events
// ---------------------------------------------------------------------------

/**
 * Outbox events (PROJECT.md section 6, AGENTS.md rule 6).
 *
 * Written in the same transaction as the state change it describes. The relay
 * publishes them to BullMQ afterwards, so no request handler ever pushes to a
 * queue directly and a crash between commit and publish cannot lose an event.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. `JOB`, `POST`, `USER`. */
    aggregateType: varchar('aggregate_type', { length: 40 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
    /** One of `DOMAIN_EVENT_TYPES`. */
    eventType: varchar('event_type', { length: 60 }).notNull(),
    /**
     * The natural identity of the EVENT, as one string.
     *
     * This exists because "an aggregate publishes an event type once" is not
     * true for stage events: a reel emits `job.stage_completed` five times, once
     * per stage, and those are five different messages to five different
     * workers. Indexing `(aggregate_type, aggregate_id, event_type)` made the
     * second stage a unique-constraint violation.
     *
     * A column rather than an expression index, because the identity of an event
     * is a rule about which events exist - not a query detail. AGENTS.md is
     * explicit that a guarantee the migration tool cannot diff is one it can
     * silently drop. Writers supply it: `JOB:<id>:job.created`,
     * `JOB:<id>:job.stage_completed:<stage>`.
     */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
  },
  (table) => ({
    // The relay's poll: exactly the unpublished rows, oldest first. Partial so
    // the index stays small instead of growing with processed history.
    pendingIdx: index('outbox_events_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.processedAt} IS NULL`),

    // One row per logical event. Re-running a handler that rewrites state is
    // then a no-op at the outbox rather than a duplicate message on the queue -
    // and the same job at five different stages is five rows, not a collision.
    dedupeIdx: uniqueIndex('outbox_events_dedupe_idx').on(table.dedupeKey),

    nonNegativeAttempts: check('outbox_events_attempts_non_negative', sql`${table.attempts} >= 0`),
  }),
);

/**
 * Per-stage checkpoint (PROJECT.md section 6: `job_checkpoints(job_id, stage,
 * output_ref, created_at, PRIMARY KEY(job_id, stage))`).
 *
 * A retry resumes at the first stage with no row here, which is what makes a
 * crashed worker cheap: a reel that already rendered its audio does not pay to
 * render it twice. The composite primary key is the mechanism - two workers
 * cannot both claim the same stage.
 *
 * `output_ref` is a storage key rather than the payload itself, so a checkpoint
 * costs a row and not a copy of the media.
 */
export const jobCheckpoints = pgTable(
  'job_checkpoints',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    stage: jobStageEnum('stage').notNull(),
    /** Storage key of the stage artefact; also carried on the outbox event. */
    outputRef: varchar('output_ref', { length: 400 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    // `PRIMARY KEY(job_id, stage)` - declared as a composite key rather than two
    // single-column `.primaryKey()` calls, which Postgres rejects.
    jobStagePk: primaryKey({
      name: 'job_checkpoints_pkey',
      columns: [table.jobId, table.stage],
    }),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;

export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;

export type RefreshSession = typeof refreshSessions.$inferSelect;
export type NewRefreshSession = typeof refreshSessions.$inferInsert;

export type PricingRule = typeof pricingRules.$inferSelect;
export type NewPricingRule = typeof pricingRules.$inferInsert;

export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;

export type JobCheckpoint = typeof jobCheckpoints.$inferSelect;
export type NewJobCheckpoint = typeof jobCheckpoints.$inferInsert;

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type CreditEntryType = (typeof creditEntryTypeEnum.enumValues)[number];
