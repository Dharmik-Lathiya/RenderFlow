import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppError,
  ERROR_CODES,
  FESTIVAL_LANGUAGES,
  festivalTemplateDescriptorSchema,
  type FestivalLanguage,
  type FestivalTemplateDescriptor,
} from '@renderflow/common';
import { priceFor, reserve } from '@renderflow/credits';
import {
  brands,
  campaigns,
  festivalOccasions,
  festivalTemplates,
  generationJobs,
  getDb,
  posts,
  type Database,
} from '@renderflow/db';

import { ModerationService } from '../jobs/moderation.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

/**
 * Festival marketing (Phase 11).
 *
 * This is an ordinary credit-critical creation path with one extra table: the
 * post, the reservation and the outbox event are written in ONE transaction, and
 * moderation runs before the wallet is touched. Nothing here pushes to a queue;
 * the outbox relay does that.
 *
 * Template selection is deliberately server-side. The client sends an occasion
 * and, optionally, a template id; the descriptor that reaches the worker is the
 * row the API read at request time, snapshotted into the job payload. A later
 * template edit therefore cannot change what the user paid for.
 */

export const createFestivalSchema = z.object({
  occasionId: z.string().trim().min(1).max(60),
  templateId: z.string().trim().min(1).max(80).optional(),
  offerText: z.string().trim().min(3).max(500),
  ctaText: z.string().trim().min(1).max(200),
  language: z.enum(FESTIVAL_LANGUAGES),
  includeReel: z.boolean().default(false),
});

export type CreateFestivalInput = z.infer<typeof createFestivalSchema>;

export interface FestivalEstimate {
  poster: number;
  /** The reel's price minus the poster's, so the breakdown reads as an add-on. */
  reelAddOn: number;
  total: number;
  includeReel: boolean;
}

export interface FestivalJobView {
  jobId: string;
  postId: string | null;
  creditsReserved: number;
  estimatedSeconds: number;
  replayed: boolean;
}

interface TemplateRow {
  id: string;
  occasionId: string;
  name: string;
  previewUrl: string;
  slots: unknown;
  colorScheme: unknown;
  audioTrack: string | null;
  dimensions: unknown;
  reelDurationSeconds: number | null;
}

@Injectable()
export class FestivalService implements OnModuleInit {
  private db!: Database;

  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly moderation: ModerationService,
  ) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  async occasions() {
    return this.db
      .select({
        id: festivalOccasions.id,
        displayName: festivalOccasions.displayName,
        iconUrl: festivalOccasions.iconUrl,
      })
      .from(festivalOccasions)
      .where(eq(festivalOccasions.active, true))
      .orderBy(festivalOccasions.displayName);
  }

  async templates(occasionId: string) {
    const rows = await this.db
      .select()
      .from(festivalTemplates)
      .where(and(eq(festivalTemplates.occasionId, occasionId), eq(festivalTemplates.active, true)))
      .orderBy(festivalTemplates.name);

    return rows.map((row) => ({
      id: row.id,
      occasionId: row.occasionId,
      name: row.name,
      previewUrl: row.previewUrl,
      colorScheme: row.colorScheme,
      dimensions: row.dimensions,
      reelDurationSeconds: row.reelDurationSeconds,
    }));
  }

  /**
   * Server-side price quote (AGENTS.md rule 7: costs never come from the client).
   *
   * The reel is priced as a BUNDLE. Showing `FESTIVAL_REEL` as its own line next
   * to a poster line would double-count the poster, so the response splits the
   * bundle into "poster" and "reel add-on" - the two numbers a user can reason
   * about - and keeps `total` authoritative.
   */
  async estimate(includeReel: boolean): Promise<FestivalEstimate> {
    const quote = await this.db.transaction(async (tx) => {
      const poster = await priceFor(tx, 'FESTIVAL_IMAGE');
      const reel = await priceFor(tx, 'FESTIVAL_REEL');
      return { poster: poster.credits, reel: reel.credits };
    });

    if (!includeReel) {
      return { poster: quote.poster, reelAddOn: 0, total: quote.poster, includeReel: false };
    }

    return {
      poster: quote.poster,
      reelAddOn: Math.max(0, quote.reel - quote.poster),
      total: quote.reel,
      includeReel: true,
    };
  }

  async create(
    userId: string,
    campaignId: string,
    input: CreateFestivalInput,
    idempotencyKey: string | undefined,
  ): Promise<FestivalJobView> {
    const scoped = await this.access.scope({
      userId,
      resource: 'campaign',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db
          .select({
            workspaceId: brands.workspaceId,
            campaignId: campaigns.id,
            brandId: campaigns.brandId,
            brand: brands,
          })
          .from(campaigns)
          .innerJoin(brands, eq(brands.id, campaigns.brandId))
          .where(eq(campaigns.id, campaignId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    const template = await this.templateFor(input.occasionId, input.templateId);

    // Before the reservation: a refused request must never move the wallet.
    await this.moderation.assertAllowed({
      prompt: `${input.offerText}\n${input.ctaText}`,
      kind: input.includeReel ? 'FESTIVAL_REEL' : 'FESTIVAL_IMAGE',
    });

    const kind = input.includeReel ? 'FESTIVAL_REEL' : 'FESTIVAL_IMAGE';
    const payload = {
      occasionId: input.occasionId,
      occasionName: await this.occasionName(input.occasionId),
      offerText: input.offerText,
      ctaText: input.ctaText,
      language: input.language,
      includeReel: input.includeReel,
      template,
      brand: {
        name: scoped.value.brand.name,
        industry: scoped.value.brand.industry,
        tone: scoped.value.brand.tone,
        audience: scoped.value.brand.audience,
        colors: scoped.value.brand.colors,
        languages: scoped.value.brand.languages,
      },
    } satisfies Record<string, unknown>;

    const reservation = await this.db.transaction(async (tx) => {
      // postId is filled in AFTER the reservation. Creating the post first would
      // leave an orphan on an idempotent replay, because `reserve` returns the
      // original job without touching anything else in this transaction.
      const reserved = await reserve(tx, {
        userId,
        kind,
        postId: null,
        workspaceId: scoped.workspaceId,
        payload,
        idempotencyKey: idempotencyKey ?? null,
      });

      if (reserved.replayed) {
        const existing = await tx
          .select({ postId: generationJobs.postId })
          .from(generationJobs)
          .where(eq(generationJobs.id, reserved.jobId))
          .limit(1);

        return {
          jobId: reserved.jobId,
          postId: existing[0]?.postId ?? null,
          cost: reserved.cost,
          replayed: true,
        };
      }

      const [post] = await tx
        .insert(posts)
        .values({
          campaignId,
          brandId: scoped.value.brandId,
          type: input.includeReel ? 'REEL' : 'POSTER',
          status: 'GENERATING',
          caption: null,
          hashtags: '',
        })
        .returning({ id: posts.id });

      if (post === undefined) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Could not create the festival post');
      }

      await tx
        .update(generationJobs)
        .set({ postId: post.id, updatedAt: new Date() })
        .where(eq(generationJobs.id, reserved.jobId));

      return {
        jobId: reserved.jobId,
        postId: post.id,
        cost: reserved.cost,
        replayed: false,
      };
    });

    return {
      jobId: reservation.jobId,
      postId: reservation.postId,
      creditsReserved: reservation.cost,
      estimatedSeconds: input.includeReel ? 60 : 20,
      replayed: reservation.replayed,
    };
  }

  private async occasionName(occasionId: string): Promise<string> {
    const rows = await this.db
      .select({ displayName: festivalOccasions.displayName })
      .from(festivalOccasions)
      .where(and(eq(festivalOccasions.id, occasionId), eq(festivalOccasions.active, true)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Unknown festival occasion');
    }
    return row.displayName;
  }

  private async templateFor(
    occasionId: string,
    templateId: string | undefined,
  ): Promise<FestivalTemplateDescriptor> {
    const rows = await this.db
      .select()
      .from(festivalTemplates)
      .where(
        templateId === undefined
          ? and(eq(festivalTemplates.occasionId, occasionId), eq(festivalTemplates.active, true))
          : and(
              eq(festivalTemplates.occasionId, occasionId),
              eq(festivalTemplates.active, true),
              eq(festivalTemplates.id, templateId),
            ),
      )
      .orderBy(festivalTemplates.name)
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No active template for that occasion');
    }

    return descriptorOf(row);
  }
}

/** Validates the JSON columns before they can reach a renderer. */
function descriptorOf(row: TemplateRow): FestivalTemplateDescriptor {
  const parsed = festivalTemplateDescriptorSchema.safeParse({
    id: row.id,
    name: row.name,
    slots: row.slots,
    colorScheme: row.colorScheme,
    dimensions: row.dimensions,
    audioTrack: row.audioTrack,
    reelDurationSeconds: row.reelDurationSeconds,
  });

  if (!parsed.success) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Festival template is misconfigured', {
      details: {
        templateId: row.id,
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      },
    });
  }

  return parsed.data;
}

/** Re-exported for the controller, so the query param schema lives with the service. */
export const estimateQuerySchema = z.object({
  includeReel: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type { FestivalLanguage };
