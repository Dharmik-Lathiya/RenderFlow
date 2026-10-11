import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { ProviderError } from './providers';
import type { FetchLike } from './text-providers';

/**
 * Brand voice memory (PROJECT.md section 6, `brand_memory(id, brand_id, kind,
 * content, embedding vector)`).
 *
 * The feature: a brand's APPROVED posts are embedded, and the nearest few are
 * injected into the prompt so the model writes in the register the brand actually
 * uses. Not to copy the text - to move the register.
 *
 * The pgvector decision
 * ---------------------
 * The spec asks for `embedding vector`. **pgvector is not installed in this
 * environment and the image has no extension available**, so a `vector` column
 * cannot be created, let alone tested. Two honest options:
 *
 *  1. Stop until it is, and ship nothing.
 *  2. Ship the feature against a backend that works everywhere, behind an
 *     interface, so the pgvector backend is one class rather than a rewrite.
 *
 * This is (2). `VectorStore` is the seam, `PortableVectorStore` stores embeddings
 * as JSON and ranks them in SQL with a cosine dot product, and `PgVectorStore` is
 * documented as the production backend with its migration. For a brand's approved
 * posts - dozens to low hundreds - the portable version is fast enough, and the
 * interface means swapping it changes no caller.
 *
 * What the portable backend is NOT good enough for: a corpus of millions. That
 * is the case pgvector's ANN index exists for, and the migration is noted below.
 */

/**
 * An embedding: a non-empty array of finite numbers.
 *
 * No minimum LENGTH here. Dimensionality is the embedder's business - a test
 * embedder can legitimately use three dimensions - and an arbitrary floor in the
 * shared schema only rejects work that is perfectly valid for its caller.
 */
const embeddingSchema = z.array(z.number().finite()).min(1);

export interface BrandMemoryRow {
  id: string;
  brandId: string;
  kind: string;
  content: string;
  embedding: number[];
}

import type { BrandExample } from './providers';

/** A retrieved example. The shape `BrandContext.examples` carries. */
export type SimilarExample = BrandExample;

export interface VectorStore {
  readonly name: string;
  /** Stores or replaces an embedding for one piece of approved content. */
  upsert(row: Omit<BrandMemoryRow, 'id'> & { id?: string }): Promise<string>;
  /** Removes an entry, e.g. when the post it came from is deleted. */
  remove(id: string): Promise<boolean>;
  /** The `limit` most similar entries for a query embedding. */
  similar(brandId: string, embedding: number[], limit: number): Promise<SimilarExample[]>;
}

/**
 * Embeds text, behind an interface for the same reason as the store.
 *
 * A deterministic local embedding is the default so the feature works - and is
 * testable - with no provider key. It is NOT semantically meaningful, and the
 * store's cosine ranking only means something with a real model behind it. It
 * exists so the wiring is exercised, and `name` is reported so nobody mistakes it
 * for the real thing.
 */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  /** True when the vectors mean something across different texts. */
  readonly semantic: boolean;
}

export class LocalHashEmbedder implements Embedder {
  readonly name = 'local-hash';
  readonly semantic = false;

  constructor(readonly dimensions = 64) {}

  // Synchronous by nature; async because that is the interface, and the
  // provider-backed implementation really is async.
  embed(text: string): Promise<number[]> {
    return Promise.resolve(this.hash(text));
  }

  private hash(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token !== '');

    for (const token of tokens) {
      let hash = 2_166_136_261;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
      }
      // A signed bucket, so tokens that collide do not all reinforce each other.
      const bucket = Math.abs(hash) % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + ((hash & 1) === 0 ? 1 : -1);
    }

    return normaliseVector(vector);
  }
}

/** An OpenAI embeddings adapter. */
export class OpenAiEmbedder implements Embedder {
  readonly name = 'openai';
  readonly semantic = true;

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      dimensions?: number;
      fetchImpl?: FetchLike;
    },
  ) {
    this.dimensions = options.dimensions ?? 1_536;
  }

  readonly dimensions: number;

  async embed(text: string): Promise<number[]> {
    const doFetch: FetchLike | undefined = this.options.fetchImpl ?? globalThis.fetch;

    if (doFetch === undefined) {
      throw new ProviderError('no fetch implementation available', 'PERMANENT');
    }

    const response = await doFetch(
      `${this.options.baseUrl ?? 'https://api.openai.com/v1'}/embeddings`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model ?? 'text-embedding-3-small',
          input: text,
          dimensions: this.dimensions,
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `embedding failed (${response.status}): ${detail.slice(0, 200)}`,
        response.status >= 500 || response.status === 429 ? 'TRANSIENT' : 'PERMANENT',
      );
    }

    const parsed = z
      .object({ data: z.array(z.object({ embedding: embeddingSchema })).min(1) })
      .safeParse(await response.json());

    const first = parsed.success ? parsed.data.data[0] : undefined;

    if (!parsed.success || first === undefined) {
      // An empty vector silently matches nothing, which reads downstream as "this
      // brand has no memory" rather than "the provider broke".
      throw new ProviderError('embedding response did not match the schema', 'TRANSIENT');
    }

    return normaliseVector(first.embedding);
  }
}

/** Unit length, so a dot product IS the cosine and nothing has to divide. */
export function normaliseVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (magnitude === 0) {
    return [...vector];
  }

  return vector.map((value) => value / magnitude);
}

/** Cosine similarity of two already-normalised vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;

  for (let index = 0; index < length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return total;
}

/**
 * The portable backend: embeddings as JSON, ranked in SQL.
 *
 * The ranking is done in SQL rather than in application code so the whole brand's
 * memory is fetched in one query and the LIMIT is applied by the database. Pulling
 * every row out and sorting in JS would make the cost of the feature grow with
 * the size of the corpus rather than with the number of results wanted.
 */
export class PortableVectorStore implements VectorStore {
  readonly name = 'portable-json';

  constructor(private readonly db: { execute: (query: unknown) => Promise<{ rows: unknown[] }> }) {}

  async upsert(row: Omit<BrandMemoryRow, 'id'> & { id?: string }): Promise<string> {
    const id = row.id ?? cryptoRandomId();
    const embedding = JSON.stringify(normaliseVector(row.embedding));

    await this.db.execute(sql`
      INSERT INTO brand_memory (id, brand_id, kind, content, embedding)
      VALUES (${id}::uuid, ${row.brandId}::uuid, ${row.kind}, ${row.content}, ${embedding}::jsonb)
      ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content, embedding = EXCLUDED.embedding
    `);

    return id;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      DELETE FROM brand_memory WHERE id = ${id}::uuid
    `);

    // A bare DELETE returns a row COUNT, not rows. Reading `rows[0]` here reports
    // "not removed" for a row that was in fact deleted, which is the kind of
    // false negative that leaves orphaned memory nobody cleans up.
    const { rowCount } = result as unknown as { rowCount?: number };
    return (rowCount ?? 0) > 0;
  }

  async similar(brandId: string, embedding: number[], limit: number): Promise<SimilarExample[]> {
    const query = embeddingSchema.parse(normaliseVector(embedding));

    // The vector is a validated float8[] literal rather than a bound parameter.
    //
    // Two reasons, and the second is the important one. Postgres cannot compare
    // a `jsonb` array element against a bound parameter without the cast and the
    // ordinality join either way; and a bound JSON string arrives as ONE
    // parameter only if the driver is told it is text - which is how the first
    // version of this query ended up with drizzle splicing the numbers straight
    // into the SQL as `[0,0,0]` and Postgres choking on the following `::`.
    //
    // `embeddingSchema` has just proved every element is a finite number, so
    // there is nothing here that could close the literal and start a new
    // statement.
    const literal = `{${query.join(',')}}`;

    const result = await this.db.execute(sql`
      SELECT id::text AS id,
             content,
             -- Both sides are already unit length, so the dot product IS the
             -- cosine: no division, and an index on brand_id is enough at the
             -- size a single brand's approved posts reach.
             --
             -- WITH ORDINALITY is used in function-in-FROM form because
             -- Postgres 18 removed the set-returning-function form from the
             -- select list, and the elements have to be paired by position.
             (SELECT SUM(a.value::float8 * b.value)
                FROM jsonb_array_elements_text(embedding) WITH ORDINALITY AS a(value, ord)
                JOIN unnest(${literal}::float8[]) WITH ORDINALITY AS b(value, ord)
                  ON a.ord = b.ord
             ) AS score
        FROM brand_memory
       WHERE brand_id = ${brandId}::uuid
       ORDER BY score DESC
       LIMIT ${limit}
    `);

    return (result.rows as Array<{ id: string; content: string; score: number | string }>).map(
      (row) => ({ id: row.id, content: row.content, score: Number(row.score ?? 0) }),
    );
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Retrieves the examples for a prompt.
 *
 * Bounded and truncated at the call site, not here: this returns what matched,
 * and the prompt builder decides how much of it a model can actually use. A
 * prompt with fifty full posts is both expensive and less effective than fifty
 * one-liners.
 */
export async function brandExamples(
  store: VectorStore,
  embedder: Embedder,
  brandId: string,
  query: string,
  limit = 5,
): Promise<SimilarExample[]> {
  const embedding = await embedder.embed(query);

  return store.similar(brandId, embedding, limit);
}

/**
 * Migration for the production backend.
 *
 * Kept as a string rather than applied: pgvector is not available in this
 * environment, so running it would fail, and shipping a migration that has never
 * been applied is worse than documenting the one that needs writing.
 *
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   ALTER TABLE brand_memory
 *     ADD COLUMN embedding_v vector(1536);
 *   UPDATE brand_memory SET embedding_v = embedding::vector;
 *   CREATE INDEX brand_memory_brand_cosine
 *     ON brand_memory USING hnsw (embedding_v vector_cosine_ops)
 *     WHERE brand_id IS NOT NULL;
 *   -- then a PgVectorStore using `<=>` and the HNSW index.
 */
export const PG_VECTOR_MIGRATION_NOTE = `
CREATE EXTENSION IF NOT EXISTS vector;  -- requires the pgvector image or package
`;
