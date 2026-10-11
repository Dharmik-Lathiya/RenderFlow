import { Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  LocalHashEmbedder,
  PortableVectorStore,
  brandExamples,
  type BrandExample,
  type Embedder,
  type VectorStore,
} from '@renderflow/ai';
import { brands, getDb, posts, type Database } from '@renderflow/db';

/**
 * Supplies the brand voice a job is generated with (PROJECT.md section 6,
 * `brand_memory`).
 *
 * Deliberately tolerant. Brand memory is a QUALITY feature: it makes the output
 * sound like the brand, and a brand with nothing approved yet still gets a
 * perfectly good generation. So every failure here degrades to "no examples"
 * rather than failing a job the user has already paid for.
 *
 * The one thing it must never do is leak. The query is scoped by brandId, and the
 * brandId comes from the post the job was created for - which the API has already
 * checked for membership. A brand's approved history is the thing most worth
 * keeping private.
 */

const brandRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  industry: z.string().nullable(),
  tone: z.string().nullable(),
  audience: z.string().nullable(),
  colors: z.array(z.string()),
  languages: z.array(z.string()),
});

export interface BrandVoice {
  name: string;
  industry: string | null;
  tone: string | null;
  audience: string | null;
  colors: string[];
  languages: string[];
  examples: BrandExample[];
}

export interface BrandVoiceOptions {
  store?: VectorStore;
  embedder?: Embedder;
  /** How many approved posts to inject. Five fits a prompt and still moves the register. */
  limit?: number;
}

@Injectable()
export class BrandVoiceService implements OnModuleInit {
  private db!: Database;
  private store: VectorStore | undefined;
  private embedder: Embedder | undefined;
  private limit = 5;

  onModuleInit(): void {
    this.db = getDb();
    // The portable backend by default. It is the one that works without the
    // pgvector extension, and swapping in a pgvector implementation later is a
    // change of one class behind this same interface.
    this.store = new PortableVectorStore(this.db as never);
    this.embedder = new LocalHashEmbedder();
  }

  /**
   * Test seam, matching `ModerationService.setModerator`.
   *
   * Deliberately not constructor injection: an optional constructor argument is a
   * dependency Nest will try to resolve, and it fails the whole module to boot
   * over a value that has a perfectly good default.
   */
  configure(options: BrandVoiceOptions): void {
    if (options.store !== undefined) this.store = options.store;
    if (options.embedder !== undefined) this.embedder = options.embedder;
    if (options.limit !== undefined) this.limit = options.limit;
  }

  /**
   * The brand behind a post, with its nearest approved posts.
   *
   * `null` when the post has no brand, which the runner treats as "use the
   * default brand context" - a post with no brand is a legitimate state early in
   * a workspace's life, not an error.
   */
  async forPost(postId: string | null, query: string): Promise<BrandVoice | null> {
    if (postId === null) {
      return null;
    }

    const post = await this.brandIdOf(postId);

    if (post === null) {
      return null;
    }

    const rows = await this.db
      .select({
        id: brands.id,
        name: brands.name,
        industry: brands.industry,
        tone: brands.tone,
        audience: brands.audience,
        colors: brands.colors,
        languages: brands.languages,
      })
      .from(brands)
      .where(eq(brands.id, post))
      .limit(1);

    const parsed = brandRowSchema.safeParse(rows[0]);

    if (!parsed.success) {
      return null;
    }

    const { id, ...brand } = parsed.data;
    return { ...brand, examples: await this.examplesOf(id, query) };
  }

  private async brandIdOf(postId: string): Promise<string | null> {
    const rows = await this.db
      .select({ brandId: posts.brandId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    return rows[0]?.brandId ?? null;
  }

  /**
   * Similarity retrieval, with every failure swallowed.
   *
   * A provider outage, a missing table, a corrupt embedding - none of them is a
   * reason to fail a generation the user has already been charged for. The worst
   * case without examples is output that is slightly less on-brand.
   */
  private async examplesOf(brandId: string, query: string): Promise<BrandExample[]> {
    const { store, embedder } = this;

    if (store === undefined) {
      return [];
    }

    try {
      return await brandExamples(
        store,
        embedder ?? new LocalHashEmbedder(),
        brandId,
        query,
        this.limit,
      );
    } catch {
      return [];
    }
  }
}
