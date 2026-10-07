import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * RenderFlow database schema (PROJECT.md section 6, Phase 1 slice).
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;

export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;

export type RefreshSession = typeof refreshSessions.$inferSelect;
export type NewRefreshSession = typeof refreshSessions.$inferInsert;

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type CreditEntryType = (typeof creditEntryTypeEnum.enumValues)[number];
