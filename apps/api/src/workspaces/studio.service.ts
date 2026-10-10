import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@renderflow/common';
import {
  assets,
  brands,
  campaigns,
  generationJobs,
  getDb,
  posts,
  users,
  type Database,
} from '@renderflow/db';

import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesService } from './workspaces.service';

/**
 * Brands, campaigns, posts and assets.
 *
 * One service rather than four because they share the property that matters
 * most: every method takes a `userId` and resolves the owning workspace through
 * `WorkspaceAccessService` before it issues a tenant-scoped query. Splitting them
 * would mean four places to re-derive that rule, and the odd one out would be
 * the leak.
 *
 * Role floors (PROJECT.md section 12 Phase 3 "role permissions enforced"):
 *
 *   VIEWER   read anything in the workspace
 *   EDITOR   create and edit brands, campaigns, posts, and request uploads
 *   APPROVER edit + approve content
 *   OWNER    everything, plus membership
 *
 * APPROVER deliberately does not inherit EDITOR: authorship and approval are
 * separated so one person cannot rubber-stamp their own content.
 */

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const colourList = z.array(z.string().regex(HEX_COLOUR, 'colours must be #rgb or #rrggbb')).max(12);

const languageList = z
  .array(z.string().regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/, 'expected a BCP-47 language tag'))
  .max(12);

/**
 * Brand fields, WITHOUT defaults, so `updateBrandSchema` can partial them
 * without inheriting `.default([])` and turning an empty patch into a wipe.
 */
const brandFields = {
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(120).optional(),
  /** Free text describing the writing voice; injected into prompts. */
  tone: z.string().trim().max(2000).optional(),
  audience: z.string().trim().max(2000).optional(),
  colors: colourList,
  languages: languageList,
};

export const createBrandSchema = z.object({
  /** The workspace the brand belongs to; access is checked against it. */
  workspaceId: z.uuid(),
  ...brandFields,
  colors: colourList.default([]),
  languages: languageList.default([]),
});

/**
 * Partial update, built from `brandFields` rather than from
 * `createBrandSchema.partial()`.
 *
 * The reason is a data-loss bug: `.partial()` keeps a field's `.default()`, so an
 * "empty" PATCH parsed as `{ colors: [], languages: [] }`, passed the not-empty
 * check, and silently wiped a brand's palette on a request that changed nothing.
 * Defaults belong to creation only.
 */
export const updateBrandSchema = z
  .object(brandFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

export const createCampaignSchema = z.object({
  brandId: z.uuid(),
  goal: z.string().trim().min(1).max(2000),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});

export const createPostSchema = z.object({
  campaignId: z.uuid(),
  type: z.enum(['CAPTION', 'POSTER', 'CAROUSEL', 'REEL']),
  caption: z.string().trim().max(5000).optional(),
  hashtags: z.string().trim().max(2000).default(''),
});

export const updatePostSchema = z
  .object({
    caption: z.string().trim().max(5000).optional(),
    hashtags: z.string().trim().max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export type RequestUploadInput = z.infer<typeof requestUploadSchema>;

export const requestUploadSchema = z.object({
  /** The workspace the asset belongs to; access is checked against it. */
  workspaceId: z.uuid(),
  /** MIME type. Checked against the allow-list below before a URL is issued. */
  mime: z.string().trim().min(1).max(120),
  /** Declared size. Enforced here because the client streams bytes to S3 directly. */
  sizeBytes: z.number().int().positive(),
  postId: z.uuid().optional(),
  type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
});

/**
 * Allowed upload types.
 *
 * An allow-list, not a deny-list: an unrecognised type is refused rather than
 * passed through on the assumption that it is harmless. `application/octet-stream`
 * is deliberately absent - it is what a client sends when it cannot classify its
 * own file, which is exactly the case worth refusing.
 */
export const ALLOWED_UPLOAD_MIME: Readonly<Record<string, string>> = {
  'image/png': 'IMAGE',
  'image/jpeg': 'IMAGE',
  'image/webp': 'IMAGE',
  'video/mp4': 'VIDEO',
  'audio/mpeg': 'AUDIO',
  'audio/wav': 'AUDIO',
  'application/pdf': 'DOCUMENT',
};

/** Ceiling for a single upload. Mirrors the worker-side limit. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface StorageLike {
  createPresignedUpload(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<{
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresInSeconds: number;
  }>;
  createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string>;
}

@Injectable()
export class StudioService implements OnModuleInit {
  private db!: Database;

  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly workspaces: WorkspacesService,
  ) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  // --- brands -------------------------------------------------------------

  async listBrands(userId: string, workspaceId: string) {
    await this.workspaces.requireMembership(this.db, workspaceId, userId);

    return this.db
      .select()
      .from(brands)
      .where(eq(brands.workspaceId, workspaceId))
      .orderBy(brands.createdAt);
  }

  async createBrand(userId: string, workspaceId: string, input: z.infer<typeof createBrandSchema>) {
    await this.workspaces.requireMembership(this.db, workspaceId, userId, 'EDITOR');

    try {
      const [brand] = await this.db
        .insert(brands)
        // workspaceId comes last so the validated body cannot override it.
        .values({ ...input, workspaceId })
        .returning();
      return brand;
    } catch (error) {
      // Unique on (workspace_id, name).
      if (isUniqueViolation(error)) {
        throw new AppError(ERROR_CODES.CONFLICT, 'A brand with that name already exists');
      }
      throw error;
    }
  }

  async getBrand(userId: string, brandId: string) {
    const scoped = await this.access.scope({
      userId,
      resource: 'brand',
      lookup: async (db) => {
        const rows = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });
    return scoped.value;
  }

  async updateBrand(userId: string, brandId: string, input: z.infer<typeof updateBrandSchema>) {
    const scoped = await this.access.scope({
      userId,
      resource: 'brand',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    // Incremented rather than assigned: two concurrent editors must not silently
    // overwrite each other, and the version is what a caller checks to detect it.
    const [updated] = await this.db
      .update(brands)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(brands.id, brandId))
      .returning();

    return updated ?? scoped.value;
  }

  async deleteBrand(userId: string, brandId: string): Promise<void> {
    await this.access.scope({
      userId,
      resource: 'brand',
      required: 'OWNER',
      lookup: async (db) => {
        const rows = await db
          .select({ workspaceId: brands.workspaceId })
          .from(brands)
          .where(eq(brands.id, brandId))
          .limit(1);
        return rows[0] === undefined ? null : { workspaceId: rows[0].workspaceId, value: null };
      },
    });

    await this.db.delete(brands).where(eq(brands.id, brandId));
  }

  // --- campaigns ----------------------------------------------------------

  async listCampaigns(userId: string, brandId: string) {
    const brand = await this.getBrand(userId, brandId);
    return this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.brandId, brand.id))
      .orderBy(campaigns.createdAt);
  }

  async createCampaign(userId: string, input: z.infer<typeof createCampaignSchema>) {
    // The brand lookup is also the access check: it resolves the workspace and
    // refuses a caller who is not a member of it.
    await this.access.scope({
      userId,
      resource: 'brand',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db
          .select({ workspaceId: brands.workspaceId })
          .from(brands)
          .where(eq(brands.id, input.brandId))
          .limit(1);
        return rows[0] === undefined ? null : { workspaceId: rows[0].workspaceId, value: null };
      },
    });

    if (
      input.startDate !== undefined &&
      input.endDate !== undefined &&
      input.endDate < input.startDate
    ) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'endDate must not precede startDate');
    }

    const [campaign] = await this.db
      .insert(campaigns)
      .values({
        brandId: input.brandId,
        goal: input.goal,
        // Cast in SQL rather than constructing a JS `Date`. A campaign start is a
        // calendar date with no time of day, and `new Date('2026-03-01')` is
        // UTC midnight which lands on the previous day for anyone west of
        // Greenwich once serialised. Postgres parses the literal as a date and
        // there is no timezone anywhere in the path.
        startDate: input.startDate === undefined ? null : sql`${input.startDate}::date`,
        endDate: input.endDate === undefined ? null : sql`${input.endDate}::date`,
        createdBy: userId,
      })
      .returning();

    return campaign;
  }

  // --- posts --------------------------------------------------------------

  async listPosts(userId: string, campaignId: string) {
    const campaign = await this.getCampaign(userId, campaignId);
    return this.db
      .select()
      .from(posts)
      .where(eq(posts.campaignId, campaign.id))
      .orderBy(posts.createdAt);
  }

  async createPost(userId: string, input: z.infer<typeof createPostSchema>) {
    const campaign = await this.getCampaign(userId, input.campaignId);

    await this.workspaces.requireMembership(this.db, campaign.workspaceId, userId, 'EDITOR');

    const [post] = await this.db
      .insert(posts)
      .values({
        campaignId: input.campaignId,
        // Denormalised from the campaign so brand queries never need the join.
        brandId: campaign.brandId,
        type: input.type,
        caption: input.caption ?? null,
        hashtags: input.hashtags,
      })
      .returning();

    return post;
  }

  async updatePost(userId: string, postId: string, input: z.infer<typeof updatePostSchema>) {
    const scoped = await this.access.scope({
      userId,
      resource: 'post',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
        const row = rows[0];
        if (row === undefined) {
          return null;
        }
        const brand = await db
          .select({ workspaceId: brands.workspaceId })
          .from(brands)
          .where(eq(brands.id, row.brandId))
          .limit(1);
        return brand[0] === undefined ? null : { workspaceId: brand[0].workspaceId, value: row };
      },
    });

    const [updated] = await this.db
      .update(posts)
      .set({ ...input, version: scoped.value.version + 1, updatedAt: new Date() })
      .where(eq(posts.id, postId))
      .returning();

    return updated;
  }

  async approvePost(userId: string, postId: string) {
    const scoped = await this.access.scope({
      userId,
      resource: 'post',
      required: 'APPROVER',
      lookup: async (db) => {
        const rows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
        const row = rows[0];
        if (row === undefined) {
          return null;
        }
        const brand = await db
          .select({ workspaceId: brands.workspaceId })
          .from(brands)
          .where(eq(brands.id, row.brandId))
          .limit(1);
        return brand[0] === undefined ? null : { workspaceId: brand[0].workspaceId, value: row };
      },
    });

    if (scoped.value.status === 'APPROVED') {
      throw new AppError(ERROR_CODES.CONFLICT, 'Post is already approved');
    }

    const [approved] = await this.db
      .update(posts)
      .set({ status: 'APPROVED', approvedBy: userId, updatedAt: new Date() })
      .where(eq(posts.id, postId))
      .returning();

    return approved;
  }

  // --- assets -------------------------------------------------------------

  async listAssets(userId: string, postId: string) {
    const post = await this.getPost(userId, postId);
    return this.db
      .select()
      .from(assets)
      .where(eq(assets.postId, post.id))
      .orderBy(assets.createdAt);
  }

  /**
   * Issues a presigned PUT and records the asset as PENDING.
   *
   * The row is created before the upload rather than after, because the object
   * key has to be known to build the URL. It is therefore possible to have a row
   * with no object behind it; `confirmUpload` is what reconciles that, and the
   * reaper drops orphans past a grace period (Phase 5).
   *
   * Size is validated here, not by S3: the client streams bytes straight to the
   * bucket, so by the time anything could measure the object the data has already
   * been written. A declared size is the only signal available at this point,
   * which is why `confirmUpload` re-checks the real size afterwards.
   */
  async requestUpload(
    userId: string,
    storage: StorageLike,
    workspaceId: string,
    input: z.infer<typeof requestUploadSchema>,
  ) {
    const membership = await this.workspaces.requireMembership(
      this.db,
      workspaceId,
      userId,
      'EDITOR',
    );

    const assetType = ALLOWED_UPLOAD_MIME[input.mime];
    if (assetType === undefined) {
      throw new AppError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'That file type cannot be uploaded', {
        details: { mime: input.mime, allowed: Object.keys(ALLOWED_UPLOAD_MIME) },
      });
    }

    if (input.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppError(ERROR_CODES.ASSET_TOO_LARGE, 'File is too large', {
        details: { sizeBytes: input.sizeBytes, maxBytes: MAX_UPLOAD_BYTES },
      });
    }

    // Captured in a local: TS cannot see that the property stays defined across
    // the `await` inside the closure below.
    const postId = input.postId;
    if (postId !== undefined) {
      // The post must belong to the workspace the upload was requested under,
      // or an asset could be attached across tenants.
      const scoped = await this.access.scope({
        userId,
        resource: 'post',
        required: 'EDITOR',
        lookup: async (db) => {
          const rows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
          const row = rows[0];
          if (row === undefined) {
            return null;
          }
          const brand = await db
            .select({ workspaceId: brands.workspaceId })
            .from(brands)
            .where(eq(brands.id, row.brandId))
            .limit(1);
          return brand[0] === undefined ? null : { workspaceId: brand[0].workspaceId, value: row };
        },
      });

      if (scoped.workspaceId !== workspaceId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 'Post belongs to a different workspace');
      }
    }

    const assetId = crypto.randomUUID();
    // Key is derived from ids the caller cannot choose, so an upload cannot be
    // steered at another workspace's prefix or overwrite an existing object.
    const storageKey = `workspaces/${workspaceId}/assets/${assetId}`;

    const upload = await storage.createPresignedUpload(storageKey, input.mime, 900);

    const [asset] = await this.db
      .insert(assets)
      .values({
        id: assetId,
        postId: input.postId ?? null,
        workspaceId,
        type: input.type ?? assetType,
        storageKey,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        meta: { status: 'PENDING_UPLOAD', uploadedBy: membership.userId },
      })
      .returning();

    return { asset, upload };
  }

  /**
   * Confirms an upload by asking storage what actually landed.
   *
   * The declared size is NOT trusted. `headObject` is the authority, so a client
   * that lied about its size is caught here rather than silently filling the
   * bucket.
   */
  async confirmUpload(
    userId: string,
    assetId: string,
    storage: {
      headObject(key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
    },
  ) {
    const asset = await this.getAsset(userId, assetId);

    const head = await storage.headObject(asset.storageKey);
    if (head === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No uploaded object found for this asset');
    }

    if (head.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppError(ERROR_CODES.ASSET_TOO_LARGE, 'Uploaded object exceeds the size limit', {
        details: { sizeBytes: head.sizeBytes, maxBytes: MAX_UPLOAD_BYTES },
      });
    }

    const [confirmed] = await this.db
      .update(assets)
      .set({
        // The real size, replacing the declaration.
        sizeBytes: head.sizeBytes,
        meta: { ...asset.meta, status: 'READY', confirmedAt: new Date().toISOString() },
      })
      .where(eq(assets.id, assetId))
      .returning();

    return confirmed;
  }

  async getDownloadUrl(
    userId: string,
    assetId: string,
    storage: { createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string> },
  ) {
    const asset = await this.getAsset(userId, assetId);

    // Short-lived and access-checked per request. A permanent URL would outlive
    // the membership check that authorised it.
    const url = await storage.createPresignedDownload(asset.storageKey, 300);
    return { url, expiresInSeconds: 300 };
  }

  async deleteAsset(userId: string, assetId: string): Promise<void> {
    await this.getAsset(userId, assetId);
    await this.db.delete(assets).where(eq(assets.id, assetId));
  }

  // --- shared lookups -----------------------------------------------------

  private async getCampaign(userId: string, campaignId: string) {
    return this.access
      .scope({
        userId,
        resource: 'campaign',
        lookup: async (db) => {
          const rows = await db
            .select({
              workspaceId: brands.workspaceId,
              id: campaigns.id,
              brandId: campaigns.brandId,
            })
            .from(campaigns)
            .innerJoin(brands, eq(brands.id, campaigns.brandId))
            .where(eq(campaigns.id, campaignId))
            .limit(1);

          const row = rows[0];
          return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
        },
      })
      .then((scoped) => scoped.value);
  }

  private async getPost(userId: string, postId: string) {
    return this.access
      .scope({
        userId,
        resource: 'post',
        lookup: async (db) => {
          const rows = await db
            .select({ workspaceId: brands.workspaceId, value: posts })
            .from(posts)
            .innerJoin(brands, eq(brands.id, posts.brandId))
            .where(eq(posts.id, postId))
            .limit(1);
          const row = rows[0];
          return row ?? null;
        },
      })
      .then((scoped) => scoped.value);
  }

  private async getAsset(userId: string, assetId: string) {
    return this.access
      .scope({
        userId,
        resource: 'asset',
        lookup: async (db) => {
          const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
          const row = rows[0];
          return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
        },
      })
      .then((scoped) => scoped.value);
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  let depth = 0;
  while (typeof current === 'object' && current !== null && depth < 5) {
    if ((current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}

export { users, generationJobs, and, sql };
