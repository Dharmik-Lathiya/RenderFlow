import {
  FESTIVAL_COUNTRIES,
  FESTIVAL_LANGUAGES,
  FESTIVAL_OCCASIONS,
  FESTIVAL_SLOT_POSITIONS,
  FESTIVAL_TEMPLATE_SEEDS,
  festivalBrandSchema,
  festivalCountryName,
  festivalJobPayloadSchema,
  festivalScriptSchema,
  festivalTemplateDescriptorSchema,
  isFestivalCountryId,
  isFestivalKind,
  isFestivalLanguage,
  isFestivalOccasionId,
} from './festival';

/**
 * Festival vocabulary unit tests.
 *
 * `festival.ts` is pure vocabulary used by the seed script, the API and the
 * worker, and it was at 0% coverage in the unit gate which pulled branch
 * coverage below the 80% floor. These tests assert the guards and the seeds
 * describe themselves, so a typo in a country id or a template that cannot be
 * parsed is a test failure rather than a festival that cannot be generated.
 */

describe('festival countries', () => {
  it('lists India first, then the rest, then Global', () => {
    expect(FESTIVAL_COUNTRIES.map((country) => country.id)).toEqual(['IN', 'US', 'GLOBAL']);
  });

  it('resolves display names and falls back to the raw id', () => {
    expect(festivalCountryName('IN')).toBe('India');
    expect(festivalCountryName('US')).toBe('United States');
    expect(festivalCountryName('GLOBAL')).toBe('Global');
    expect(festivalCountryName('XX')).toBe('XX');
  });

  it('accepts known country ids only', () => {
    expect(isFestivalCountryId('IN')).toBe(true);
    expect(isFestivalCountryId('US')).toBe(true);
    expect(isFestivalCountryId('GLOBAL')).toBe(true);
    expect(isFestivalCountryId('in')).toBe(false);
    expect(isFestivalCountryId('XX')).toBe(false);
    expect(isFestivalCountryId(null)).toBe(false);
    expect(isFestivalCountryId(42)).toBe(false);
  });
});

describe('festival occasions', () => {
  it('accepts seeded occasion ids only', () => {
    for (const occasion of FESTIVAL_OCCASIONS) {
      expect(isFestivalOccasionId(occasion.id)).toBe(true);
    }
    expect(isFestivalOccasionId('DIWALI')).toBe(true);
    expect(isFestivalOccasionId('THANKSGIVING')).toBe(true);
    expect(isFestivalOccasionId('CHRISTMAS')).toBe(true);
    expect(isFestivalOccasionId('diwali')).toBe(false);
    expect(isFestivalOccasionId('EASTER')).toBe(false);
    expect(isFestivalOccasionId(null)).toBe(false);
  });

  it('gives every seeded occasion a country and most a featured date', () => {
    for (const occasion of FESTIVAL_OCCASIONS) {
      expect(isFestivalCountryId(occasion.country)).toBe(true);
      expect(occasion.displayName.length).toBeGreaterThan(0);
      if (occasion.featuredDate !== null) {
        expect(occasion.featuredDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('keeps Custom global and dateless', () => {
    const custom = FESTIVAL_OCCASIONS.find((occasion) => occasion.id === 'CUSTOM');
    expect(custom?.country).toBe('GLOBAL');
    expect(custom?.featuredDate).toBeNull();
  });

  it('keeps the big Indian and foreign occasions in the catalogue', () => {
    const ids = FESTIVAL_OCCASIONS.map((occasion) => occasion.id);
    expect(ids).toContain('DIWALI');
    expect(ids).toContain('CHRISTMAS');
    expect(ids).toContain('THANKSGIVING');
    expect(ids).toContain('VALENTINES_DAY');
  });
});

describe('festival languages and kinds', () => {
  it('accepts the documented languages only', () => {
    expect([...FESTIVAL_LANGUAGES]).toEqual(['english', 'hindi', 'both']);
    expect(isFestivalLanguage('english')).toBe(true);
    expect(isFestivalLanguage('hindi')).toBe(true);
    expect(isFestivalLanguage('both')).toBe(true);
    expect(isFestivalLanguage('french')).toBe(false);
    expect(isFestivalLanguage(1)).toBe(false);
  });

  it('accepts only festival job kinds', () => {
    expect(isFestivalKind('FESTIVAL_IMAGE')).toBe(true);
    expect(isFestivalKind('FESTIVAL_REEL')).toBe(true);
    expect(isFestivalKind('POSTER')).toBe(false);
    expect(isFestivalKind('REEL')).toBe(false);
  });
});

describe('festival template seeds', () => {
  it('covers every occasion with at least one template', () => {
    for (const occasion of FESTIVAL_OCCASIONS) {
      expect(FESTIVAL_TEMPLATE_SEEDS.some((template) => template.occasionId === occasion.id)).toBe(
        true,
      );
    }
  });

  it('publishes descriptors the job payload schema accepts', () => {
    for (const template of FESTIVAL_TEMPLATE_SEEDS) {
      const parsed = festivalTemplateDescriptorSchema.safeParse({
        id: template.id,
        name: template.name,
        slots: template.slots,
        colorScheme: template.colorScheme,
        dimensions: template.dimensions,
        audioTrack: template.audioTrack,
        reelDurationSeconds: template.reelDurationSeconds,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('uses only valid slot positions', () => {
    for (const template of FESTIVAL_TEMPLATE_SEEDS) {
      for (const slot of template.slots) {
        expect([...FESTIVAL_SLOT_POSITIONS]).toContain(slot.position);
      }
    }
  });
});

describe('festival payload schemas', () => {
  const validTemplate = FESTIVAL_TEMPLATE_SEEDS[0] as NonNullable<
    (typeof FESTIVAL_TEMPLATE_SEEDS)[number]
  >;

  const descriptor = {
    id: validTemplate.id,
    name: validTemplate.name,
    slots: validTemplate.slots,
    colorScheme: validTemplate.colorScheme,
    dimensions: validTemplate.dimensions,
    audioTrack: validTemplate.audioTrack,
    reelDurationSeconds: validTemplate.reelDurationSeconds,
  };

  function payload() {
    return {
      occasionId: 'DIWALI',
      occasionName: 'Diwali',
      offerText: '20% off',
      ctaText: 'Order now',
      language: 'english',
      includeReel: false,
      template: descriptor,
      brand: {
        name: 'Acme',
        colors: ['#FF9933'],
        languages: ['en'],
      },
    };
  }

  it('accepts a complete festival job payload', () => {
    expect(festivalJobPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it('rejects a payload with an unknown language', () => {
    expect(festivalJobPayloadSchema.safeParse({ ...payload(), language: 'french' }).success).toBe(
      false,
    );
  });

  it('rejects a template with an invalid colour', () => {
    const bad = {
      ...descriptor,
      colorScheme: { ...descriptor.colorScheme, primary: 'orange' },
    };
    expect(festivalTemplateDescriptorSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a template with an invalid slot id', () => {
    const bad = {
      ...descriptor,
      slots: [{ id: 'Headline', type: 'text', position: 'center' }],
    };
    expect(festivalTemplateDescriptorSchema.safeParse(bad).success).toBe(false);
  });

  it('validates the brand header and the generated script', () => {
    const brand = {
      name: 'Acme',
      industry: 'retail',
      colors: ['#112233'],
      languages: ['en', 'hi'],
    };
    expect(festivalBrandSchema.safeParse(brand).success).toBe(true);
    expect(festivalBrandSchema.safeParse({ ...brand, colors: ['not-a-color'] }).success).toBe(
      false,
    );

    const script = {
      slots: { headline: 'Happy Diwali', offer: '20% off', cta: 'Order now' },
      caption: 'Happy Diwali from Acme',
      hashtags: ['diwali', 'offer'],
    };
    expect(festivalScriptSchema.safeParse(script).success).toBe(true);
    expect(festivalScriptSchema.safeParse({ ...script, caption: '' }).success).toBe(false);
    expect(
      festivalScriptSchema.safeParse({ ...script, hashtags: new Array(31).fill('x') }).success,
    ).toBe(false);
  });
});
