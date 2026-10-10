import { Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { reserveOnce } from '@renderflow/credits';
import {
  brands,
  generationJobs,
  getDb,
  jobCheckpoints,
  posts,
  type Database,
} from '@renderflow/db';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

/**
 * Generation endpoints (PROJECT.md section 10: `POST /posts/:id/generate`,
 * `GET /jobs/:id`, `GET /jobs/:id/events`).
 *
 * Creating a job reserves credits and writes the `job.created` outbox event in
 * ONE transaction, so a job can never exist without its reservation and the
 * relay can never see an event for a job that was rolled back.
 *
 * Nothing here pushes to a queue (AGENTS.md rule 6): the relay does that.
 */

export const generateSchema = z.object({
  type: z.enum(['CAPTION', 'POSTER', 'CAROUSEL', 'REEL']),
  /** Optional overrides for the mock providers; ignored by real ones. */
  images: z.number().int().positive().max(10).optional(),
  scenes: z.number().int().positive().max(10).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
  goal: z.string().trim().max(200).optional(),
});

export interface JobView {
  id: string;
  postId: string | null;
  kind: string;
  status: string;
  stage: string;
  creditsReserved: number;
  refunded: boolean;
  captured: boolean;
  error: string | null;
  /** Stages completed so far, in pipeline order. */
  completedStages: string[];
  createdAt: string;
  finishedAt: string | null;
}

@Injectable()
export class JobsService implements OnModuleInit {
  private db!: Database;

  constructor(private readonly access: WorkspaceAccessService) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Creates a generation job for a post, reserving its credits.
   *
   * The post lookup doubles as the access check: it resolves the owning
   * workspace and refuses a caller who is not a member of it.
   */
  async generate(
    userId: string,
    postId: string,
    input: z.infer<typeof generateSchema>,
    idempotencyKey: string | undefined,
  ): Promise<{ job: JobView; replayed: boolean }> {
    const scoped = await this.access.scope({
      userId,
      resource: 'post',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db
          .select({
            workspaceId: brands.workspaceId,
            id: posts.id,
            brandId: posts.brandId,
          })
          .from(posts)
          .innerJoin(brands, eq(brands.id, posts.brandId))
          .where(eq(posts.id, postId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    // Only the keys the caller supplied are forwarded, so a payload cannot smuggle
    // in fields the pipeline does not expect.
    const payload = {
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.scenes === undefined ? {} : { scenes: input.scenes }),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
    };

    const reservation = await reserveOnce(this.db, {
      userId,
      kind: input.type,
      postId,
      workspaceId: scoped.workspaceId,
      payload,
      idempotencyKey: idempotencyKey ?? null,
    });

    const job = await this.view(reservation.jobId, userId);
    return { job, replayed: reservation.replayed };
  }

  /** Reads a job, refusing a caller who cannot see its workspace. */
  async get(userId: string, jobId: string): Promise<JobView> {
    await this.assertCanSee(userId, jobId);
    return this.view(jobId, userId);
  }

  /**
   * Current progress snapshot.
   *
   * The SSE endpoint polls this rather than subscribing to an in-process event
   * bus, so it works across API instances and survives a reconnect: the durable
   * record is `job_checkpoints`, not a message someone has to receive.
   */
  async progress(userId: string, jobId: string): Promise<JobView> {
    await this.assertCanSee(userId, jobId);
    return this.view(jobId, userId);
  }

  /** True once the job will not change again, so SSE can close. */
  async isSettled(jobId: string): Promise<boolean> {
    const rows = await this.db
      .select({ status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);

    const status = rows[0]?.status;
    return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
  }

  private async assertCanSee(userId: string, jobId: string): Promise<void> {
    await this.access.scope({
      userId,
      resource: 'job',
      lookup: async (db) => {
        const rows = await db
          .select({ workspaceId: brands.workspaceId, id: generationJobs.id })
          .from(generationJobs)
          .innerJoin(posts, eq(posts.id, generationJobs.postId))
          .innerJoin(brands, eq(brands.id, posts.brandId))
          .where(eq(generationJobs.id, jobId))
          .limit(1);

        const row = rows[0];
        // A job with no post has no brand and therefore no workspace to check
        // against; those are internal jobs and no HTTP caller may read them.
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });
  }

  private async view(jobId: string, _userId: string): Promise<JobView> {
    const rows = await this.db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    const job = rows[0];

    if (job === undefined) {
      throw new AppError(ERROR_CODES.JOB_NOT_FOUND, 'Job not found', { details: { jobId } });
    }

    const checkpoints = await this.db
      .select({ stage: jobCheckpoints.stage })
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, jobId))
      .orderBy(jobCheckpoints.createdAt);

    return {
      id: job.id,
      postId: job.postId,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      creditsReserved: job.creditsReserved,
      refunded: job.refunded === 1,
      captured: job.captured === 1,
      error: job.error,
      completedStages: checkpoints.map((row) => row.stage),
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }
}
