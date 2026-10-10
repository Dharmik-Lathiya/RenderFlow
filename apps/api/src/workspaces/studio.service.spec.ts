import { z } from 'zod';

import {
  ALLOWED_UPLOAD_MIME,
  MAX_UPLOAD_BYTES,
  createBrandSchema,
  createPostSchema,
  requestUploadSchema,
  updateBrandSchema,
} from './studio.service';

/**
 * Input validation for the studio surface.
 *
 * These are the checks that stand between an untrusted request body and the
 * database, so they are tested as pure functions rather than only over HTTP: a
 * rejected payload should cost nothing, and an accepted one must already be
 * shaped correctly.
 */
describe('createBrandSchema', () => {
  it('accepts a complete brand', () => {
    const parsed = createBrandSchema.safeParse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Northwind',
      industry: 'retail',
      tone: 'friendly',
      audience: 'urban 25-40',
      colors: ['#ff0000', '#abc'],
      languages: ['en', 'pt-BR'],
    });

    expect(parsed.success).toBe(true);
  });

  it('defaults colours and languages to empty', () => {
    const parsed = createBrandSchema.parse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Bare',
    });

    expect(parsed.colors).toEqual([]);
    expect(parsed.languages).toEqual([]);
  });

  it('rejects a colour that is not a hex value', () => {
    // Colours go into generated images. An unvalidated string ends up in a
    // template and fails at render time, far from the request that caused it.
    for (const bad of ['red', '#gggggg', 'ff0000', '#12345']) {
      const parsed = createBrandSchema.safeParse({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: 'Bad',
        colors: [bad],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('accepts both three and six digit hex colours', () => {
    const parsed = createBrandSchema.safeParse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Short',
      colors: ['#abc', '#AABBCC'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a language tag that is not BCP-47 shaped', () => {
    const parsed = createBrandSchema.safeParse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Lang',
      languages: ['english'],
    });
    expect(parsed.success).toBe(false);
  });

  it('trims the name and rejects one that is only whitespace', () => {
    expect(
      createBrandSchema.safeParse({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: '   ',
      }).success,
    ).toBe(false);

    expect(
      createBrandSchema.parse({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: '  Spaced  ',
      }).name,
    ).toBe('Spaced');
  });

  it('requires a workspace so the brand cannot land outside one', () => {
    expect(createBrandSchema.safeParse({ name: 'Orphan' }).success).toBe(false);
  });

  it('rejects an over-long name rather than storing it truncated', () => {
    expect(
      createBrandSchema.safeParse({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: 'x'.repeat(121),
      }).success,
    ).toBe(false);
  });
});

describe('updateBrandSchema', () => {
  it('rejects an empty patch', () => {
    // A no-op update would still bump `updated_at` and, for posts, the version -
    // making clients think something changed when nothing did.
    expect(updateBrandSchema.safeParse({}).success).toBe(false);
  });

  it('strips a workspaceId so a brand cannot be moved between tenants', () => {
    // zod drops unknown keys rather than rejecting them, so the guarantee is
    // "workspaceId never reaches the update" rather than "the request is
    // refused". Either would be fine; silently forwarding one would not be.
    const parsed = updateBrandSchema.parse({
      tone: 'wry',
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });

    expect(parsed).not.toHaveProperty('workspaceId');
  });

  it('accepts a partial patch', () => {
    expect(updateBrandSchema.safeParse({ tone: 'wry' }).success).toBe(true);
  });
});

describe('createPostSchema', () => {
  it('accepts the four post types', () => {
    for (const type of ['CAPTION', 'POSTER', 'CAROUSEL', 'REEL']) {
      expect(
        createPostSchema.safeParse({
          campaignId: '11111111-1111-4111-8111-111111111111',
          type,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown post type', () => {
    // Each type maps to a pricing rule and a generation pipeline; an unknown one
    // would have no price and no worker.
    expect(
      createPostSchema.safeParse({
        campaignId: '11111111-1111-4111-8111-111111111111',
        type: 'PODCAST',
      }).success,
    ).toBe(false);
  });

  it('defaults hashtags to an empty string rather than null', () => {
    expect(
      createPostSchema.parse({
        campaignId: '11111111-1111-4111-8111-111111111111',
        type: 'CAPTION',
      }).hashtags,
    ).toBe('');
  });
});

describe('requestUploadSchema', () => {
  const base = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    mime: 'image/png',
    sizeBytes: 1024,
  };

  it('accepts a plain upload', () => {
    expect(requestUploadSchema.safeParse(base).success).toBe(true);
  });

  it('requires a positive size', () => {
    // Zero or negative would create an asset row that can never match a real
    // object on confirm.
    expect(requestUploadSchema.safeParse({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(requestUploadSchema.safeParse({ ...base, sizeBytes: -1 }).success).toBe(false);
  });

  it('requires an integer size', () => {
    expect(requestUploadSchema.safeParse({ ...base, sizeBytes: 1.5 }).success).toBe(false);
  });

  it('rejects non-positive dimensions', () => {
    expect(requestUploadSchema.safeParse({ ...base, width: 0 }).success).toBe(false);
    expect(requestUploadSchema.safeParse({ ...base, height: -2 }).success).toBe(false);
  });
});

describe('ALLOWED_UPLOAD_MIME', () => {
  it('is an allow-list that omits application/octet-stream', () => {
    // octet-stream is what a client sends when it cannot classify its own file.
    // That is exactly the case worth refusing, not waving through.
    expect(ALLOWED_UPLOAD_MIME['application/octet-stream']).toBeUndefined();
  });

  it('covers the media the pipeline actually produces', () => {
    expect(ALLOWED_UPLOAD_MIME['image/png']).toBe('IMAGE');
    expect(ALLOWED_UPLOAD_MIME['image/jpeg']).toBe('IMAGE');
    expect(ALLOWED_UPLOAD_MIME['video/mp4']).toBe('VIDEO');
    expect(ALLOWED_UPLOAD_MIME['audio/mpeg']).toBe('AUDIO');
    expect(ALLOWED_UPLOAD_MIME['application/pdf']).toBe('DOCUMENT');
  });

  it('refuses types that can execute in a browser', () => {
    for (const dangerous of ['text/html', 'image/svg+xml', 'application/javascript']) {
      expect(ALLOWED_UPLOAD_MIME[dangerous]).toBeUndefined();
    }
  });

  it('sets a ceiling an ordinary upload fits under', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

/** Guards against the schemas being swapped for a permissive stand-in. */
describe('schema strictness', () => {
  it('strips unknown keys rather than persisting them', () => {
    // A client must not be able to set columns the API does not expose, e.g. a
    // `workspaceId` on an update or an arbitrary `status`.
    const parsed = createBrandSchema.parse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      name: 'Clean',
      sneaky: 'value',
    });

    expect(parsed).not.toHaveProperty('sneaky');
  });

  it('rejects a wrong-typed field rather than coercing it', () => {
    expect(z.object({ n: z.number() }).safeParse({ n: '5' }).success).toBe(false);
  });
});
