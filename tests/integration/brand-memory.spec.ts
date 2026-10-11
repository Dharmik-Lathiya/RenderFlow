import { eq } from 'drizzle-orm';

import {
  LocalHashEmbedder,
  OpenAiEmbedder,
  PortableVectorStore,
  ProviderError,
  brandExamples,
  cosine,
  normaliseVector,
} from '@renderflow/ai';
import { brands, users, workspaces } from '@renderflow/db';

import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Brand voice memory (PROJECT.md section 6).
 *
 * The `embedding` column is JSON, not `vector`: pgvector is not available in this
 * environment and the image ships no extension for it. What these tests prove is
 * that the PORTABLE backend does what it claims - stores, removes, and ranks by
 * cosine in SQL - so swapping in a pgvector implementation later is a change of
 * one class, not a rewrite.
 */

describe('normaliseVector', () => {
  it('produces unit length, so a dot product IS the cosine', () => {
    const unit = normaliseVector([3, 4]);
    expect(unit).toEqual([0.6, 0.8]);
  });

  it('leaves a zero vector alone rather than dividing by zero', () => {
    // An empty content string embeds to nothing; NaN there would poison every
    // ranking it appears in.
    expect(normaliseVector([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('cosine', () => {
  it('is 1 for identical vectors and -1 for opposites', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('tolerates different lengths by comparing the overlap', () => {
    expect(Number.isFinite(cosine([1, 0], [1, 0, 0, 0]))).toBe(true);
  });
});

describe('LocalHashEmbedder', () => {
  const embedder = new LocalHashEmbedder();

  it('is deterministic', async () => {
    // A test that depends on a random embedding can only assert on shape, which
    // is not what the ranking needs.
    expect(await embedder.embed('rain again')).toEqual(await embedder.embed('rain again'));
  });

  it('produces unit-length vectors', async () => {
    const vector = await embedder.embed('some caption about the weather');
    expect(cosine(vector, vector)).toBeCloseTo(1);
  });

  it('scores text sharing a word above text sharing none', async () => {
    // Not semantic - `semantic` says so, and the flag exists so nobody mistakes
    // this for the real thing.
    const query = await embedder.embed('the weather is wet');
    const close = await embedder.embed('wet weather today');
    const far = await embedder.embed('quarterly revenue figures');

    expect(cosine(query, close)).toBeGreaterThan(cosine(query, far));
  });

  it('reports that it is not semantic', () => {
    expect(embedder.semantic).toBe(false);
  });

  it('handles empty text without producing NaN', async () => {
    const vector = await embedder.embed('');
    expect(vector.every(Number.isFinite)).toBe(true);
  });
});

describe('OpenAiEmbedder', () => {
  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    } as unknown as Response;
  }

  it('parses and normalises a real response', async () => {
    const embedder = new OpenAiEmbedder({
      apiKey: 'k',
      dimensions: 3,
      fetchImpl: async () => ok({ data: [{ embedding: [3, 4, 0] }] }),
    });

    expect(await embedder.embed('x')).toEqual([0.6, 0.8, 0]);
  });

  it('reports itself as semantic', () => {
    expect(new OpenAiEmbedder({ apiKey: 'k' }).semantic).toBe(true);
  });

  it('treats a rate limit as transient', async () => {
    const embedder = new OpenAiEmbedder({
      apiKey: 'k',
      fetchImpl: async () =>
        ({ ok: false, status: 429, text: async () => 'slow down' }) as unknown as Response,
    });

    await expect(embedder.embed('x')).rejects.toMatchObject({ classification: 'TRANSIENT' });
  });

  it('treats a bad key as permanent', async () => {
    const embedder = new OpenAiEmbedder({
      apiKey: 'k',
      fetchImpl: async () =>
        ({ ok: false, status: 401, text: async () => 'nope' }) as unknown as Response,
    });

    await expect(embedder.embed('x')).rejects.toMatchObject({ classification: 'PERMANENT' });
  });

  it('raises a typed error rather than returning an empty vector', async () => {
    const embedder = new OpenAiEmbedder({
      apiKey: 'k',
      fetchImpl: async () => ok({ unexpected: true }),
    });

    // An empty vector silently matches nothing, which reads as "this brand has
    // no memory" rather than "the provider broke".
    await expect(embedder.embed('x')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('PortableVectorStore, against a real database', () => {
  let db: TestDb;
  const embedder = new LocalHashEmbedder();

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  function store(): PortableVectorStore {
    return new PortableVectorStore(db as never);
  }

  /**
   * A brand, created through the real tables so the foreign key is satisfied the
   * way production satisfies it.
   */
  async function seedBrand(): Promise<string> {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `brand-${userId}@example.com`,
      passwordHash: 'x',
      name: 'Brand',
    });

    const workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({ id: workspaceId, name: 'Acme', ownerId: userId });

    const brandId = crypto.randomUUID();
    await db.insert(brands).values({
      id: brandId,
      workspaceId,
      name: 'Acme',
      industry: 'retail',
      colors: [],
      languages: ['en'],
    });

    return brandId;
  }

  it('stores and retrieves an embedding', async () => {
    const brandId = await seedBrand();
    const vectorStore = store();
    const embedding = await embedder.embed('rain again on the platform');

    const id = await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Rain again on the platform.',
      embedding,
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const found = await vectorStore.similar(brandId, embedding, 5);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id, content: 'Rain again on the platform.' });
    expect(found[0]?.score).toBeCloseTo(1);
  });

  it('ranks the closest content first', async () => {
    const brandId = await seedBrand();
    const vectorStore = store();

    await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Quarterly revenue figures attached.',
      embedding: await embedder.embed('quarterly revenue figures'),
    });
    await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Wet weather all day.',
      embedding: await embedder.embed('wet weather all day'),
    });

    const found = await vectorStore.similar(
      brandId,
      await embedder.embed('wet weather all day'),
      5,
    );

    expect(found).toHaveLength(2);
    expect(found[0]?.content).toBe('Wet weather all day.');
    // Ordered, not merely correct: a ranking that returns the right pair in the
    // wrong order is no better than no ranking at all.
    expect(found[0]?.score ?? 0).toBeGreaterThan(found[1]?.score ?? 0);
  });

  it("never returns another brand's memory", async () => {
    // The whole feature is per brand. Leaking across would put one customer's
    // approved voice into another customer's prompts.
    const mine = await seedBrand();
    const theirs = await seedBrand();
    const vectorStore = store();
    const embedding = await embedder.embed('shared words here');

    await vectorStore.upsert({ brandId: theirs, kind: 'post', content: 'Theirs.', embedding });

    expect(await vectorStore.similar(mine, embedding, 10)).toHaveLength(0);
  });

  it('honours the limit', async () => {
    const brandId = await seedBrand();
    const vectorStore = store();

    for (const content of ['one', 'two', 'three', 'four']) {
      await vectorStore.upsert({
        brandId,
        kind: 'post',
        content,
        embedding: await embedder.embed(content),
      });
    }

    expect(await vectorStore.similar(brandId, await embedder.embed('one'), 2)).toHaveLength(2);
  });

  it('replaces rather than duplicating on a re-embed', async () => {
    // A post that gets re-approved should not appear twice in its own prompt.
    const brandId = await seedBrand();
    const vectorStore = store();
    const id = await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'First version.',
      embedding: await embedder.embed('first'),
    });

    await vectorStore.upsert({
      id,
      brandId,
      kind: 'post',
      content: 'Second version.',
      embedding: await embedder.embed('second'),
    });

    const found = await vectorStore.similar(brandId, await embedder.embed('second'), 10);
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe('Second version.');
  });

  it('removes an entry', async () => {
    const brandId = await seedBrand();
    const vectorStore = store();
    const id = await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Temporary.',
      embedding: await embedder.embed('temporary'),
    });

    expect(await vectorStore.remove(id)).toBe(true);
    expect(await vectorStore.similar(brandId, await embedder.embed('temporary'), 10)).toHaveLength(
      0,
    );
  });

  it('cascades when the brand is deleted', async () => {
    // Orphaned memory for a brand that no longer exists is both a leak waiting to
    // happen and a row nobody will ever clean up.
    const brandId = await seedBrand();
    const vectorStore = store();
    await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Gone soon.',
      embedding: await embedder.embed('gone soon'),
    });

    await db.delete(brands).where(eq(brands.id, brandId));

    expect(await vectorStore.similar(brandId, await embedder.embed('gone soon'), 10)).toHaveLength(
      0,
    );
  });

  it('retrieves through the helper the prompt builder uses', async () => {
    const brandId = await seedBrand();
    const vectorStore = store();

    await vectorStore.upsert({
      brandId,
      kind: 'post',
      content: 'Bring a coat.',
      embedding: await embedder.embed('bring a coat'),
    });

    const examples = await brandExamples(vectorStore, embedder, brandId, 'wet weather', 5);
    expect(examples).toHaveLength(1);
  });
});
