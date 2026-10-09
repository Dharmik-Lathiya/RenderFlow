import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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

    // An aggregate can publish a given event type once. Re-running a handler
    // that rewrites state is then a no-op at the outbox rather than a duplicate
    // message on the queue.
    dedupeIdx: uniqueIndex('outbox_events_dedupe_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.eventType,
    ),

    nonNegativeAttempts: check('outbox_events_attempts_non_negative', sql`${table.attempts} >= 0`),
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

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type CreditEntryType = (typeof creditEntryTypeEnum.enumValues)[number];
