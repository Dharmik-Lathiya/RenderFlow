# Index review

Phase 10 asks for an index review. This is the review: every index in
`libs/db/src/schema.ts` matched to the query that needs it, the one gap that
review found, and the benchmark that shows the difference.

**Last reviewed:** 2026-10-29, against the schema at migration `0014`.

## Method

1. Enumerate every index and the query paths in `apps/*` and `libs/*`.
2. Write each hot query against a scratch Postgres database seeded with 50,000
   posts and 100,100 publish jobs.
3. Run `EXPLAIN (ANALYZE, BUFFERS)` before and after the candidate index.
4. Pin the surviving indexes in `tests/integration/schema-indexes.spec.ts`, so a
   later migration cannot drop one and still pass the suite.

Indexes that only serve a constraint (primary keys, unique claims) are listed
with the guarantee they enforce, not a read query.

## Access paths

| Table               | Index                                                      | What it serves                                                                   |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `users`             | `users_email_key` (unique)                                 | Login and registration lookup.                                                   |
| `credit_ledger`     | `credit_ledger_reference_key` (partial unique)             | C8/C10 idempotency: one RESERVE/CAPTURE/REFUND per reference.                    |
| `credit_ledger`     | `credit_ledger_signup_bonus_once` (partial unique)         | C1: one signup bonus per user.                                                   |
| `credit_ledger`     | `credit_ledger_user_id_created_at_idx`                     | Credit history, newest first.                                                    |
| `refresh_sessions`  | token hash (unique), user id, expires at                   | Session lookup, per-user revoke, expired-session cleanup.                        |
| `auth_tokens`       | token hash (unique), `(user_id, purpose)`                  | Email verification and password reset.                                           |
| `generation_jobs`   | `generation_jobs_user_idempotency_key` (partial unique)    | C10: one job per user and Idempotency-Key.                                       |
| `generation_jobs`   | `generation_jobs_reclaim_idx` (partial)                    | Reaper: `PENDING`/`PROCESSING` with `locked_until < now()`.                      |
| `generation_jobs`   | `generation_jobs_user_id_created_at_idx`                   | Job list for a user; the reserve replay lookup also starts here.                 |
| `brands`            | `brands_workspace_id_name_key` (unique)                    | Brand list per workspace and name collision.                                     |
| `campaigns`         | `campaigns_brand_id_idx`                                   | Campaigns for a brand.                                                           |
| `posts`             | `posts_campaign_id_idx`                                    | Posts in a campaign.                                                             |
| `posts`             | `posts_brand_id_idx`                                       | Posts for a brand.                                                               |
| `posts`             | `posts_scheduled_at_idx` (partial)                         | Calendar: scheduled posts in a date window, ordered by time.                     |
| `assets`            | `assets_post_id_idx`, `assets_workspace_id_idx`            | Assets on a post, and workspace-level assets.                                    |
| `assets`            | `assets_storage_key_key` (unique)                          | One row per stored object.                                                       |
| `social_accounts`   | `social_accounts_workspace_platform_external_idx` (unique) | Reconnect updates the existing account.                                          |
| `social_accounts`   | `social_accounts_workspace_id_idx`                         | Accounts a workspace publishes to.                                               |
| `publish_jobs`      | `publish_jobs_idempotency_key` (partial unique)            | One schedule request, one set of rows.                                           |
| `publish_jobs`      | `publish_jobs_post_account_idx` (partial unique)           | No double live-publish to the same account; reschedule after FAILED still works. |
| `publish_jobs`      | `publish_jobs_due_idx` (partial)                           | Publisher poll: due `PENDING`/`SCHEDULED` rows.                                  |
| `publish_jobs`      | `publish_jobs_reclaim_idx` (partial)                       | Reaper: unfinished rows with an expired lease.                                   |
| `publish_jobs`      | `publish_jobs_external_post_id_idx` (partial)              | Double-post guard before a retry.                                                |
| `publish_jobs`      | `publish_jobs_metrics_idx` (partial)                       | Analytics sync: published rows with an external id, oldest first.                |
| `publish_jobs`      | `publish_jobs_post_id_idx`                                 | A post's full publication history, including FAILED and PUBLISHED rows.          |
| `post_metrics`      | `post_metrics_job_fetched_idx` (unique)                    | Idempotent metric snapshot per job and fetch time.                               |
| `post_metrics`      | `post_metrics_fetched_at_idx`                              | Retention sweep and time-range reads.                                            |
| `notifications`     | `notifications_user_id_created_at_idx`                     | Notification centre, newest first.                                               |
| `notifications`     | `notifications_user_id_unread_idx` (partial)               | Unread count and unread-only list.                                               |
| `notifications`     | `notifications_dedupe_key_idx` (partial unique)            | One notification per failure, not one per retry.                                 |
| `outbox_events`     | `outbox_events_pending_idx` (partial)                      | Relay poll: `processed_at IS NULL`, oldest first.                                |
| `outbox_events`     | `outbox_events_dedupe_idx` (unique)                        | One row per logical event.                                                       |
| `job_checkpoints`   | primary key `(job_id, stage)`                              | Resume at the first incomplete stage.                                            |
| `workspace_members` | primary key `(workspace_id, user_id)`                      | Membership check on every scoped request.                                        |
| `workspace_members` | `workspace_members_user_id_idx`                            | Workspaces for a user.                                                           |
| `wallets`           | primary key `user_id`                                      | Wallet read/update by owner.                                                     |
| `pricing_rules`     | `pricing_rules_active_idx`                                 | Active price lookup; the API never trusts a client price.                        |
| `audit_logs`        | `audit_logs_actor_id_idx`, `audit_logs_created_at_idx`     | Operator investigation by actor or time.                                         |

## What the review changed

The partial unique index on `(post_id, social_account_id)` only covers
`PENDING`, `SCHEDULED` and `PUBLISHING`. Two queries ask for a post's **entire**
history: the Idempotency-Key replay check and the post-detail publication list.
Postgres cannot use a partial index for rows outside its predicate, so those
queries fell back to a sequential scan of the whole table.

On a scratch database with 50,000 posts and 100,100 publish jobs:

| Plan                                                      | Execution time | Buffers |
| --------------------------------------------------------- | -------------: | ------: |
| Before: `Seq Scan on publish_jobs`, 100,098 rows filtered |      34.360 ms |   2,861 |
| After: `Bitmap Index Scan on publish_jobs_post_id_idx`    |       0.116 ms |       7 |

The scratch database holds one tenant. In production the scan grows with every
tenant's publishing history, while the indexed lookup stays proportional to one
post's rows. Migration `0014_absent_tomorrow_man.sql` adds the index.

## Deliberate omissions

- **`generation_jobs.post_id`.** The column is written but never read as a
  filter; the API reaches a job by id or by `(user_id, created_at)`. An index
  here would only cost writes.
- **`posts (brand_id, scheduled_at)`.** The calendar filters by workspace and a
  date range. The planner can use `posts_scheduled_at_idx` for a narrow window
  and filter the workspace through the brand join; a composite index would be
  larger and only help a very wide window. Revisit if calendar traffic stops
  being date-bounded.
- **`brand_memory.embedding`.** Stored as JSON, deliberately: pgvector is not
  available in this environment. A brand has dozens to low hundreds of approved
  posts, so the cosine ranking scans a bounded set per brand, which
  `brand_memory_brand_id_idx` already narrows.
- **`audit_logs (actor_id, created_at)`.** The two single-column indexes are
  enough for operator queries, which are ad hoc and low volume. A composite
  would be speculative.

## Verifying a future change

`tests/integration/schema-indexes.spec.ts` fails if any reviewed index is missing
after migrations. It does not assert a plan shape: the planner can legitimately
choose a sequential scan on a small test table, and a test that forces
`enable_seqscan = off` would assert a decision rather than the schema. The
benchmark above is the performance evidence; the test is the regression guard.
