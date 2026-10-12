import { eq, inArray, sql } from 'drizzle-orm';
import { outboxEvents, posts, publishJobs, socialAccounts } from '@renderflow/db';
import type { Database, DbTransaction } from '@renderflow/db';

import type { SocialAdapter, SocialPlatform } from './adapter';
import { claimPublishJobs, findStalePublishJobs, publishJob } from './publisher';
import type { ClaimedPublishJob, PublishDeps, PublishOutcome } from './publisher';
import type { PlatformRateLimiter, TokenRefresher, TokenRefresherRegistry } from './runtime';
import type { TokenCipher } from './tokens';

/**
 * The publisher worker's brain (Phase 7, `apps/publisher-worker`).
 *
 * `publishJob` does the one thing that must never be wrong. This module does
 * everything around it: leases, heartbeats, token refresh, rate limits, the
 * post's own status, the outbox events other processes react to, and telling
 * the user when it all fails.
 *
 * Split out of the app for the same reason `libs/jobs/src/runner.ts` is: the
 * behaviour worth testing - a worker killed mid-publish, a token that expired an
 * hour ago - needs a real database and a controllable clock, and neither is
 * reachable from inside a `main()`.
 */

/** What the processor needs told about a failure, without knowing the API. */
export interface PublishNotifier {
  notify(input: {
    userId: string;
    type: 'publish_failed' | 'publish_succeeded' | 'credit_refunded' | 'credits_low';
    title: string;
    body: string;
    dedupeKey?: string;
  }): Promise<void>;
}

export interface PublishProcessorOptions {
  db: Database;
  adapterFor: (platform: SocialPlatform) => SocialAdapter;
  notify: PublishNotifier;
  /** This process's lease identity. */
  workerId: string;
  /**
   * Encrypts the refreshed token.
   *
   * Required only when `refresh` is set, and the type says so: refreshing
   * without somewhere to put the new token is a no-op that would leave the
   * account permanently one failure behind, which looks exactly like "refresh
   * is broken" and is much harder to diagnose.
   */
  tokens?: TokenCipher;
  /** How long a claim is held before the sweep may take it. */
  leaseSeconds?: number;
  /** How often to extend it while a publish is in flight. */
  heartbeatSeconds?: number;
  /** Rows taken per pass. */
  batchSize?: number;
  /** Per-platform limiter, so a burst does not get the whole app throttled. */
  limiterFor?: (platform: SocialPlatform) => PlatformRateLimiter;
  /** The platform-facing refresher the registry wraps. */
  refresherFor?: (platform: SocialPlatform) => TokenRefresher;
  /**
   * Token refresh.
   *
   * Optional, because a platform with no refresh token has nothing to refresh
   * and a worker with no registry is still correct - the AUTH_EXPIRED path
   * degrades to "tell the user to reconnect", which is the honest outcome.
   */
  refresh?: TokenRefresherRegistry;
  /** Injectable clock, so a test does not sleep through a schedule. */
  now?: () => Date;
}

interface ResolvedOptions extends PublishProcessorOptions {
  leaseSeconds: number;
  heartbeatSeconds: number;
  batchSize: number;
}

const DEFAULTS = {
  leaseSeconds: 120,
  heartbeatSeconds: 30,
  batchSize: 10,
};

/** One stored token blob: the two halves are encrypted together, always. */
interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
}

export class PublishProcessor {
  private readonly deps: PublishDeps;
  private readonly options: ResolvedOptions;

  constructor(options: PublishProcessorOptions) {
    this.options = { ...DEFAULTS, ...options };
    this.deps = { db: options.db, adapterFor: options.adapterFor };
  }

  /**
   * One pass: claim whatever is due, publish it, report it.
   *
   * Called from a queue message AND from the poll loop. That redundancy is the
   * design: the queue entry is a wake-up that arrives on time, and the poll is
   * the truth-based backstop for one that never arrived. Whichever gets there
   * first does the work; the other finds nothing claimable and returns.
   *
   * Never throws. A publish that fails is a row to update and a user to tell,
   * not an exception that stops the rest of the batch.
   */
  async runOnce(): Promise<PublishOutcome[]> {
    const claimed = await claimPublishJobs(this.deps, {
      now: this.now(),
      batchSize: this.options.batchSize,
      workerId: this.options.workerId,
      leaseSeconds: this.options.leaseSeconds,
    });

    const outcomes: PublishOutcome[] = [];

    for (const job of claimed) {
      outcomes.push(await this.processOne(job));
    }

    return outcomes;
  }

  /** One claimed job, with the lease renewed underneath it. */
  private async processOne(claimed: ClaimedPublishJob): Promise<PublishOutcome> {
    const heartbeat = this.startHeartbeat(claimed.job.id);

    try {
      let outcome = await this.attempt(claimed);

      // An expired token is the one failure where retrying with the SAME token
      // is pointless. Refresh once, then try again - and only once, because a
      // second AUTH_EXPIRED after a successful refresh means the platform is
      // refusing this account, not that the clock ran out.
      if (outcome.errorClassification === 'AUTH_EXPIRED' && this.options.refresh !== undefined) {
        if (await this.refreshToken(claimed)) {
          const requeued = await this.reclaim(claimed);
          outcome = requeued === null ? outcome : await this.attempt(requeued);
        }
      }

      await this.record(claimed, outcome);
      return outcome;
    } finally {
      // ALWAYS stopped, including on a throw. A heartbeat left running renews a
      // lease nobody holds, and the sweep then skips a job that is genuinely
      // stuck - the failure this whole mechanism exists to prevent.
      heartbeat.stop();
    }
  }

  /**
   * One publish attempt, through the platform's rate limiter.
   */
  private async attempt(claimed: ClaimedPublishJob): Promise<PublishOutcome> {
    const limiter = this.options.limiterFor?.(claimed.platform);

    if (limiter === undefined) {
      return publishJob(this.deps, claimed);
    }

    try {
      return await limiter.run(() => publishJob(this.deps, claimed));
    } catch (error) {
      await this.releaseWithoutPlatformCall(claimed.job.id);

      return {
        jobId: claimed.job.id,
        status: 'RETRY',
        externalPostId: null,
        externalUrl: null,
        recovered: false,
        error: error instanceof Error ? error.message : 'the platform rate limit was reached',
        errorClassification: 'TRANSIENT',
      };
    }
  }

  /**
   * Undoes a claim for a job that never reached the platform.
   *
   * Two things have to be undone, and the second is the one that is easy to miss:
   *
   *  - the row stays PUBLISHING with a lease nobody will renew, so it waits for
   *    the sweep - up to a full lease - before anything retries it;
   *  - `attempts` was already incremented at claim time, and a local throttle
   *    says nothing about whether the platform is healthy. Charging an attempt
   *    for a call that never left the process means a burst of posts scheduled
   *    together can exhaust every job's retries without the platform ever being
   *    asked to do anything, and each one fails permanently for no visible
   *    reason.
   *
   * `GREATEST(..., 0)` because the column has a `>= 0` CHECK, and going negative
   * would fail the update and leave the row exactly as stuck as it was.
   */
  private async releaseWithoutPlatformCall(jobId: string): Promise<void> {
    const now = this.now();

    await this.options.db
      .update(publishJobs)
      .set({
        status: 'PENDING',
        workerId: null,
        lockedUntil: null,
        heartbeatAt: null,
        attempts: sql`GREATEST(${publishJobs.attempts} - 1, 0)`,
        error: 'waiting for a slot in the platform rate limit',
        updatedAt: now,
      })
      .where(eq(publishJobs.id, jobId));
  }

  /**
   * Persists what happened and tells everyone who needs to know.
   *
   * Outbox rows go out for BOTH outcomes, because consumers are allowed to react
   * to failures - an analytics sync that only counts successes will happily
   * report a calendar that looks emptier than it is.
   */
  private async record(claimed: ClaimedPublishJob, outcome: PublishOutcome): Promise<void> {
    const published =
      (outcome.status === 'PUBLISHED' || outcome.status === 'RECOVERED') &&
      outcome.externalPostId !== null;
    const terminalFailure = outcome.status === 'FAILED';

    if (published || terminalFailure) {
      await this.options.db.transaction(async (tx) => {
        if (published) {
          await this.writePostEvent(tx, claimed, outcome);
        }

        if (terminalFailure) {
          await this.writeFailureEvent(tx, claimed, outcome);
        }

        await this.advancePost(tx, claimed.job.postId);
      });
    }

    if (terminalFailure) {
      await this.notifyFailure(claimed, outcome);
    }
  }

  private async writePostEvent(
    tx: DbTransaction,
    claimed: ClaimedPublishJob,
    outcome: PublishOutcome,
  ): Promise<void> {
    await tx
      .insert(outboxEvents)
      .values({
        aggregateType: 'PUBLISH_JOB',
        aggregateId: outcome.jobId,
        eventType: 'post.published',
        dedupeKey: `PUBLISH:${outcome.jobId}:post.published`,
        payload: {
          eventType: 'post.published',
          postId: claimed.job.postId,
          publishJobId: outcome.jobId,
          platform: claimed.platform,
          externalPostId: outcome.externalPostId ?? '',
        },
      })
      // Already recorded, by an earlier attempt that crashed between the write
      // and the status update.
      .onConflictDoNothing();
  }

  private async writeFailureEvent(
    tx: DbTransaction,
    claimed: ClaimedPublishJob,
    outcome: PublishOutcome,
  ): Promise<void> {
    await tx
      .insert(outboxEvents)
      .values({
        aggregateType: 'PUBLISH_JOB',
        aggregateId: outcome.jobId,
        eventType: 'post.publish_failed',
        dedupeKey: `PUBLISH:${outcome.jobId}:post.publish_failed`,
        payload: {
          eventType: 'post.publish_failed',
          postId: claimed.job.postId,
          publishJobId: outcome.jobId,
          platform: claimed.platform,
          reason: outcome.error ?? 'the platform rejected the post',
        },
      })
      .onConflictDoNothing();
  }

  /**
   * Moves the post to PUBLISHING, PUBLISHED or FAILED.
   *
   * Derived from the publish jobs rather than set optimistically, because a post
   * going to three accounts is published three times and only the last of them
   * finishes.
   *
   * A post that published to SOME targets reads as FAILED. That is deliberate:
   * marking it PUBLISHED would hide the one account that needs reconnecting,
   * which is the only thing the user can act on. The individual jobs carry the
   * detail, and `post_status` has no partial state to carry it in.
   */
  private async advancePost(tx: DbTransaction, postId: string): Promise<void> {
    const counts = await tx.execute<{ live: string; failed: string; done: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('PENDING','SCHEDULED','PUBLISHING'))::text AS live,
        COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
        COUNT(*) FILTER (WHERE status = 'PUBLISHED')::text AS done
        FROM publish_jobs
       WHERE post_id = ${postId}::uuid
    `);

    const live = Number(counts.rows[0]?.live ?? '0');
    const failed = Number(counts.rows[0]?.failed ?? '0');
    const done = Number(counts.rows[0]?.done ?? '0');

    const next = live > 0 ? 'PUBLISHING' : done > 0 && failed === 0 ? 'PUBLISHED' : 'FAILED';

    await tx.update(posts).set({ status: next, updatedAt: this.now() }).where(eq(posts.id, postId));
  }

  /**
   * Tells the person who connected the account.
   *
   * Not the post's author and not the workspace owner: the thing that just
   * failed is somebody's social account, and the person who connected it is the
   * one who can fix it.
   *
   * The dedupe key is the publish job, so a job that fails three times produces
   * one notification whose body says how far it got, rather than three
   * identical cards.
   */
  private async notifyFailure(claimed: ClaimedPublishJob, outcome: PublishOutcome): Promise<void> {
    const account = await this.options.db
      .select({
        connectedBy: socialAccounts.connectedBy,
        displayName: socialAccounts.displayName,
      })
      .from(socialAccounts)
      .where(eq(socialAccounts.id, claimed.job.socialAccountId))
      .limit(1);

    const owner = account[0]?.connectedBy;

    if (owner === undefined) {
      // The account was disconnected while the publish was in flight. There is
      // nobody to tell and no one left to publish for.
      return;
    }

    await this.options.notify.notify({
      userId: owner,
      type: 'publish_failed',
      title: 'A post did not publish',
      body:
        `${account[0]?.displayName ?? claimed.platform}: ${outcome.error ?? 'unknown failure'} ` +
        `(attempt ${claimed.job.attempts} of ${claimed.job.maxAttempts})`,
      dedupeKey: `publish-failed:${outcome.jobId}`,
    });
  }

  /**
   * Refreshes the account's token and STORES the new one.
   *
   * The store is the part that is easy to forget and the part that matters: a
   * refresh that computes a valid new token and then leaves the old ciphertext
   * in place looks, from the outside, exactly like refresh being broken, and
   * fails the same way every time.
   *
   * Returns whether it worked. A failed refresh is not retried here - the caller
   * falls through to the normal failure path, which tells the user to reconnect,
   * and that IS the right outcome for a revoked refresh token.
   *
   * **KNOWN GAP: the dedupe is per process, not per cluster.**
   * `TokenRefresherRegistry` collapses concurrent refreshes inside one worker,
   * which is what stops three jobs in one batch from burning three refresh
   * tokens. Two publisher-worker PROCESSES can still both refresh the same
   * account at the same moment; on a platform that rotates refresh tokens the
   * second call fails and the account needs reconnecting. A Postgres advisory
   * lock would close it, but that means holding a connection open across the
   * platform call, which AGENTS.md section 6 forbids outright. Recorded in
   * PROJECT.md section 12 rather than half-solved here.
   */
  private async refreshToken(claimed: ClaimedPublishJob): Promise<boolean> {
    const { refresh, tokens } = this.options;

    if (refresh === undefined || tokens === undefined) {
      return false;
    }

    const stored = await this.loadToken(claimed.job.socialAccountId);

    if (stored === null) {
      return false;
    }

    const outcome = await refresh.refreshOnce(
      claimed.platform,
      stored.refreshToken ?? '',
      // Dedupe key is the ACCOUNT, not the job: two jobs to the same account
      // failing at once must not both call the platform, because a refresh
      // invalidates the previous refresh token and the loser logs the account
      // out.
      `account:${claimed.job.socialAccountId}`,
    );

    if (!outcome.refreshed || outcome.accessToken === undefined) {
      return false;
    }

    // Access and refresh go back together, under one envelope. Writing them
    // separately could leave a new access token paired with an old refresh
    // token - the one combination every platform rejects, with a message that
    // does not say why.
    const renewed: StoredToken = {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken ?? stored.refreshToken,
    };

    await this.options.db
      .update(socialAccounts)
      .set({
        token: tokens.encrypt(JSON.stringify(renewed)),
        tokenExpiresAt: outcome.expiresAt ?? null,
        updatedAt: this.now(),
      })
      .where(eq(socialAccounts.id, claimed.job.socialAccountId));

    return true;
  }

  /**
   * Decrypts an account's token.
   *
   * Returns null rather than throwing: an account whose token cannot be read
   * with the current key is a configuration problem, and the right response is
   * for this job to fail with "needs a reconnect" rather than for the worker to
   * throw on every job for every account.
   */
  private async loadToken(accountId: string): Promise<StoredToken | null> {
    const rows = await this.options.db
      .select({ token: socialAccounts.token })
      .from(socialAccounts)
      .where(eq(socialAccounts.id, accountId))
      .limit(1);

    const payload = rows[0]?.token;

    if (payload === undefined || this.options.tokens === undefined) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(this.options.tokens.decrypt(payload));

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('accessToken' in parsed) ||
        typeof (parsed as StoredToken).accessToken !== 'string'
      ) {
        return null;
      }

      const stored = parsed as StoredToken;
      return {
        accessToken: stored.accessToken,
        refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Puts a job back in the queue after a token refresh.
   *
   * `publishJob` left the row claimable, so a claim would find it - except that
   * `locked_until` may still be in the future from the attempt that just failed.
   * Clearing it makes the retry immediate rather than one lease later, which is
   * up to two minutes of a post sitting ready to go.
   */
  private async reclaim(claimed: ClaimedPublishJob): Promise<ClaimedPublishJob | null> {
    const now = this.now();

    await this.options.db
      .update(publishJobs)
      .set({ lockedUntil: null, heartbeatAt: now, updatedAt: now })
      .where(eq(publishJobs.id, claimed.job.id));

    const [reclaimed] = await claimPublishJobs(this.deps, {
      now,
      batchSize: 1,
      workerId: this.options.workerId,
      leaseSeconds: this.options.leaseSeconds,
    });

    if (reclaimed === undefined || reclaimed.job.id !== claimed.job.id) {
      // Another worker took it. That is fine - it will do the same work, and the
      // three idempotency checks are what make two workers safe.
      return null;
    }

    return reclaimed;
  }

  /**
   * Renews the lease while a publish is in flight.
   *
   * A reel upload can outlast the lease. Without this the sweep would hand the
   * job to a second worker mid-publish - and although the no-double-post
   * guarantee would still hold, two workers would fight over one job for the
   * rest of its attempts, which is how a genuine failure turns into a slow one.
   */
  private startHeartbeat(jobId: string): { stop: () => void } {
    const intervalMs = Math.max(1_000, this.options.heartbeatSeconds * 1_000);

    const timer = setInterval(() => {
      const until = new Date(this.now().getTime() + this.options.leaseSeconds * 1_000);

      void this.options.db
        .update(publishJobs)
        .set({ heartbeatAt: this.now(), lockedUntil: until })
        .where(eq(publishJobs.id, jobId))
        .catch(() => {
          // A renewal that fails is not fatal on its own - the sweep is the
          // backstop. Swallowed HERE specifically so it cannot reject an interval
          // callback, which Node would surface as an unhandled rejection.
        });
    }, intervalMs);

    // A publish timer must not be the reason the process stays alive.
    timer.unref();

    return { stop: () => clearInterval(timer) };
  }

  /**
   * Returns jobs whose publisher died mid-publish to the queue.
   *
   * A thin wrapper over `sweepStalePublishJobs`, which is what `apps/reaper`
   * calls directly - recovery belongs with the other recovery, and a publisher
   * that is simply down should not depend on that same publisher coming back to
   * notice.
   */
  async sweep(limit = 50): Promise<number> {
    // Wrapped, not passed as `this.now`: `now` reads `this.options`, so a bare
    // method reference would arrive with no `this` and throw on the first sweep.
    return sweepStalePublishJobs(this.options.db, limit, () => this.now());
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/**
 * Returns jobs whose publisher died mid-publish to the queue.
 *
 * The reset is to PENDING rather than to PUBLISHING so the job goes through the
 * claim path again - and therefore through all three idempotency checks - rather
 * than resuming mid-publish.
 *
 * Takes a plain `now` rather than reading the clock, because the reaper runs on
 * a timer and a test wants to control the boundary between "expired" and "still
 * held".
 */
export async function sweepStalePublishJobs(
  db: Database,
  limit = 50,
  now: (() => Date) | undefined = undefined,
): Promise<number> {
  const clock = now ?? ((): Date => new Date());
  const stale = await findStalePublishJobs(db, limit);

  if (stale.length === 0) {
    return 0;
  }

  await db
    .update(publishJobs)
    .set({
      status: 'PENDING',
      workerId: null,
      lockedUntil: null,
      heartbeatAt: null,
      updatedAt: clock(),
    })
    .where(
      inArray(
        publishJobs.id,
        stale.map((job) => job.id),
      ),
    );

  return stale.length;
}
