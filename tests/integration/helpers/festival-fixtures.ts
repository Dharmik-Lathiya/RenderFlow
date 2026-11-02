import {
  FESTIVAL_OCCASIONS,
  FESTIVAL_TEMPLATE_SEEDS,
  type FestivalOccasionId,
} from '@renderflow/common';
import { festivalOccasions, festivalTemplates } from '@renderflow/db';
import { eq } from 'drizzle-orm';

import type { TestDb } from './test-database';

/**
 * Publishes the festival catalogue the way `pnpm db:seed` does.
 *
 * These tables are reference data, like `pricing_rules`, so they are not in
 * `truncateAll`. A suite seeds them once; `onConflictDoNothing` makes a second
 * suite's seed harmless.
 */
export async function seedFestival(db: TestDb): Promise<void> {
  await db
    .insert(festivalOccasions)
    .values(
      FESTIVAL_OCCASIONS.map((occasion) => ({
        id: occasion.id,
        displayName: occasion.displayName,
        active: true,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(festivalTemplates)
    .values(
      FESTIVAL_TEMPLATE_SEEDS.map((template) => ({
        id: template.id,
        occasionId: template.occasionId,
        name: template.name,
        previewUrl: template.previewUrl,
        slots: template.slots,
        colorScheme: template.colorScheme,
        audioTrack: template.audioTrack,
        dimensions: template.dimensions,
        reelDurationSeconds: template.reelDurationSeconds,
        active: true,
      })),
    )
    .onConflictDoNothing();
}

/** A template that definitely exists for the occasion, for request bodies. */
export function templateIdFor(occasionId: FestivalOccasionId): string {
  const template = FESTIVAL_TEMPLATE_SEEDS.find((row) => row.occasionId === occasionId);
  if (template === undefined) {
    throw new Error(`no seeded template for ${occasionId}`);
  }
  return template.id;
}

/** Removes a template, to exercise the "no active template" path. */
export async function deactivateTemplate(db: TestDb, templateId: string): Promise<void> {
  await db
    .update(festivalTemplates)
    .set({ active: false })
    .where(eq(festivalTemplates.id, templateId));
}
