/**
 * Festival marketing vocabulary (Phase 11).
 *
 * The occasion list and template descriptors live here because three different
 * processes need the same shape: the seed script writes them, the API validates
 * against them, and the worker renders from them. Keeping the definition in one
 * place means a template slot the worker cannot draw is a type error rather than
 * a poster that silently comes out with no text on it.
 *
 * Only the DESCRIPTOR is shared. The catalogue itself remains rows in
 * `festival_occasions` / `festival_templates`, so changing a template is a data
 * change and `pnpm db:seed` stays the single way to publish one.
 */

import { z } from 'zod';

/**
 * Countries the catalogue is organised by.
 *
 * The ids are intentionally tiny and stable ('IN', 'US', 'GLOBAL'): they are
 * what `festival_occasions.country` stores and what the API echoes back, so a
 * rename would touch the database. `GLOBAL` is there for occasions that are not
 * tied to one market - "Custom" is the workspace's own celebration.
 *
 * Order matters for the UI: India first, because that is where most users
 * launch campaigns from, then the rest alphabetically.
 */
export const FESTIVAL_COUNTRIES = [
  { id: 'IN', name: 'India' },
  { id: 'US', name: 'United States' },
  { id: 'GLOBAL', name: 'Global' },
] as const;

export type FestivalCountryId = (typeof FESTIVAL_COUNTRIES)[number]['id'];

/** Resolves a country's display name; an unknown id falls back to the raw id. */
export function festivalCountryName(countryId: string): string {
  return FESTIVAL_COUNTRIES.find((country) => country.id === countryId)?.name ?? countryId;
}

export function isFestivalCountryId(value: unknown): value is FestivalCountryId {
  return typeof value === 'string' && FESTIVAL_COUNTRIES.some((country) => country.id === value);
}

/** Launch occasions. The database id is the stable key; the label is display only. */
export const FESTIVAL_OCCASIONS = [
  { id: 'DIWALI', displayName: 'Diwali', country: 'IN', featuredDate: '2026-11-08' },
  { id: 'CHRISTMAS', displayName: 'Christmas', country: 'US', featuredDate: '2026-12-25' },
  { id: 'NEW_YEAR', displayName: 'New Year', country: 'US', featuredDate: '2027-01-01' },
  {
    id: 'INDEPENDENCE_DAY',
    displayName: 'Independence Day',
    country: 'IN',
    featuredDate: '2027-08-15',
  },
  { id: 'EID', displayName: 'Eid', country: 'IN', featuredDate: '2027-03-20' },
  { id: 'HOLI', displayName: 'Holi', country: 'IN', featuredDate: '2027-03-25' },
  { id: 'ONAM', displayName: 'Onam', country: 'IN', featuredDate: '2027-08-23' },
  {
    id: 'THANKSGIVING',
    displayName: 'Thanksgiving',
    country: 'US',
    featuredDate: '2026-11-26',
  },
  {
    id: 'VALENTINES_DAY',
    displayName: "Valentine's Day",
    country: 'US',
    featuredDate: '2027-02-14',
  },
  { id: 'CUSTOM', displayName: 'Custom', country: 'GLOBAL', featuredDate: null },
] as const;

export type FestivalOccasionId = (typeof FESTIVAL_OCCASIONS)[number]['id'];

/**
 * The dates above are hand-maintained seed DISPLAY data, not an authoritative
 * calendar: Diwali drifts against the Gregorian year, Eid follows the moon, and
 * a stale date is a marketing nuisance rather than a correctness bug.
 * Re-seeding publishes an update (`pnpm db:seed` upserts occasions).
 */

export function isFestivalOccasionId(value: unknown): value is FestivalOccasionId {
  return typeof value === 'string' && FESTIVAL_OCCASIONS.some((occasion) => occasion.id === value);
}

/** Which language the copy is written in. "both" means English with Hindi lines. */
export const FESTIVAL_LANGUAGES = ['english', 'hindi', 'both'] as const;
export type FestivalLanguage = (typeof FESTIVAL_LANGUAGES)[number];

export function isFestivalLanguage(value: unknown): value is FestivalLanguage {
  return typeof value === 'string' && (FESTIVAL_LANGUAGES as readonly string[]).includes(value);
}

/** Where a text slot sits on the poster. */
export const FESTIVAL_SLOT_POSITIONS = ['top-center', 'center', 'bottom-center'] as const;
export type FestivalSlotPosition = (typeof FESTIVAL_SLOT_POSITIONS)[number];

export interface FestivalTemplateSlot {
  id: string;
  type: 'text' | 'image';
  /** Required for text slots; the worker rejects longer copy. */
  maxChars?: number;
  position: FestivalSlotPosition;
  /** Pixel size at 1080px wide; the renderer scales it for other sizes. */
  fontSize?: number;
}

export interface FestivalColorScheme {
  primary: string;
  accent: string;
  background: string;
}

export interface FestivalDimensions {
  width: number;
  height: number;
}

/**
 * Everything the pipeline needs to render one template.
 *
 * The API snapshots this into the job payload at request time. A template edit
 * between reservation and render therefore cannot change what the user paid for.
 */
export interface FestivalTemplateDescriptor {
  id: string;
  name: string;
  slots: FestivalTemplateSlot[];
  colorScheme: FestivalColorScheme;
  dimensions: FestivalDimensions;
  audioTrack: string | null;
  reelDurationSeconds: number | null;
}

/** A template as `pnpm db:seed` publishes it. */
export interface FestivalTemplateSeed extends FestivalTemplateDescriptor {
  occasionId: FestivalOccasionId;
  previewUrl: string;
}

const STANDARD_SLOTS: FestivalTemplateSlot[] = [
  { id: 'headline', type: 'text', maxChars: 30, position: 'top-center', fontSize: 64 },
  { id: 'offer', type: 'text', maxChars: 60, position: 'center', fontSize: 48 },
  { id: 'cta', type: 'text', maxChars: 40, position: 'bottom-center', fontSize: 36 },
];

/**
 * One template per occasion for v1.
 *
 * `audioTrack` is null on purpose: the seeded catalogue must not reference an
 * object that a fresh install has not uploaded. The reel renderer treats a
 * missing track as "silent reel", which is a working output rather than a failed
 * job.
 */
export const FESTIVAL_TEMPLATE_SEEDS: readonly FestivalTemplateSeed[] = [
  {
    id: 'diwali-glow-v1',
    occasionId: 'DIWALI',
    name: 'Diwali Glow',
    previewUrl: 'templates/diwali-glow-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#FF9933', accent: '#FFD700', background: '#1A1A2E' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'christmas-warmth-v1',
    occasionId: 'CHRISTMAS',
    name: 'Christmas Warmth',
    previewUrl: 'templates/christmas-warmth-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#C62828', accent: '#F9D976', background: '#0B3D2E' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'new-year-sparkle-v1',
    occasionId: 'NEW_YEAR',
    name: 'New Year Sparkle',
    previewUrl: 'templates/new-year-sparkle-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#7C4DFF', accent: '#FFD700', background: '#0B1026' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'independence-tricolour-v1',
    occasionId: 'INDEPENDENCE_DAY',
    name: 'Tricolour Pride',
    previewUrl: 'templates/independence-tricolour-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#FF9933', accent: '#138808', background: '#0D1B2A' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'eid-radiance-v1',
    occasionId: 'EID',
    name: 'Eid Radiance',
    previewUrl: 'templates/eid-radiance-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#D4AF37', accent: '#FFFFFF', background: '#0F2A2A' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'holi-colour-v1',
    occasionId: 'HOLI',
    name: 'Holi Colour',
    previewUrl: 'templates/holi-colour-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#E91E63', accent: '#FFEB3B', background: '#2A0A2E' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'onam-bloom-v1',
    occasionId: 'ONAM',
    name: 'Onam Bloom',
    previewUrl: 'templates/onam-bloom-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#F2C14E', accent: '#FFFFFF', background: '#123524' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'brand-celebration-v1',
    occasionId: 'CUSTOM',
    name: 'Brand Celebration',
    previewUrl: 'templates/brand-celebration-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#6366F1', accent: '#F59E0B', background: '#101828' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'thanksgiving-feast-v1',
    occasionId: 'THANKSGIVING',
    name: 'Thanksgiving Feast',
    previewUrl: 'templates/thanksgiving-feast-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#D2691E', accent: '#FFEB3B', background: '#3E2723' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
  {
    id: 'valentines-love-v1',
    occasionId: 'VALENTINES_DAY',
    name: 'Valentine’s Love',
    previewUrl: 'templates/valentines-love-v1/preview.png',
    slots: STANDARD_SLOTS,
    colorScheme: { primary: '#E91E63', accent: '#F8BBD0', background: '#4A148C' },
    dimensions: { width: 1080, height: 1080 },
    audioTrack: null,
    reelDurationSeconds: 15,
  },
];

export function isFestivalKind(kind: string): kind is 'FESTIVAL_IMAGE' | 'FESTIVAL_REEL' {
  return kind === 'FESTIVAL_IMAGE' || kind === 'FESTIVAL_REEL';
}

/**
 * The validated shape of a festival job payload.
 *
 * The API snapshots the template and brand into the payload at request time, so
 * a template edit between reservation and render cannot change what the user
 * paid for. The runner re-validates it like any other queue payload: a job row is
 * not a trusted channel once a worker reads it.
 */
export const festivalTemplateDescriptorSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  slots: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z][a-z0-9_]*$/, 'slot ids are lowercase identifiers'),
        type: z.enum(['text', 'image']),
        maxChars: z.number().int().min(1).max(500).optional(),
        position: z.enum(FESTIVAL_SLOT_POSITIONS),
        fontSize: z.number().int().min(8).max(240).optional(),
      }),
    )
    .min(1)
    .max(20),
  colorScheme: z.object({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  dimensions: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
  }),
  audioTrack: z.string().min(1).max(400).nullable(),
  reelDurationSeconds: z.number().int().min(1).max(60).nullable(),
});

export const festivalBrandSchema = z.object({
  name: z.string().min(1).max(160),
  industry: z.string().max(160).nullable().optional(),
  tone: z.string().max(2_000).nullable().optional(),
  audience: z.string().max(2_000).nullable().optional(),
  colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(10),
  languages: z.array(z.string().max(20)).max(10),
});

export const festivalJobPayloadSchema = z.object({
  occasionId: z.string().min(1).max(60),
  occasionName: z.string().min(1).max(160),
  offerText: z.string().min(1).max(500),
  ctaText: z.string().min(1).max(200),
  language: z.enum(FESTIVAL_LANGUAGES),
  includeReel: z.boolean(),
  template: festivalTemplateDescriptorSchema,
  brand: festivalBrandSchema.optional(),
});

export type FestivalJobPayload = z.infer<typeof festivalJobPayloadSchema>;

/** The copy the runner persists between the SCRIPT and IMAGE stages. */
export const festivalScriptSchema = z.object({
  slots: z.record(z.string().min(1).max(60), z.string().min(1).max(500)),
  caption: z.string().min(1).max(2_200),
  hashtags: z.array(z.string().min(1).max(60)).max(30),
});

export type FestivalScript = z.infer<typeof festivalScriptSchema>;
