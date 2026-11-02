/**
 * Seeds `pricing_rules` from `DEFAULT_PRICES`.
 *
 * Run with `pnpm db:seed`, after `pnpm db:migrate`.
 *
 * Why this exists at all: prices live in a table, not in code, because they have
 * to be changeable without a deploy (AGENTS.md rule 6). But a table that ships
 * empty means every generation 500s on a fresh install, so something has to
 * populate it once. `DEFAULT_PRICES` in `libs/credits/pricing.ts` is that
 * something, and it is the *only* place a price is written down - this script
 * copies it rather than restating it, so the two cannot drift.
 *
 * Idempotent by construction: `ON CONFLICT DO UPDATE` on the action. Re-running
 * after changing a price in code updates the row rather than failing.
 *
 * It also publishes the festival catalogue (`festival_occasions` and
 * `festival_templates`). Those rows are reference data, like prices: the API and
 * the renderer both read them, and an empty table means the festival flow has
 * nothing to offer. The descriptors come from `@renderflow/common` so the seed,
 * the API and the worker cannot disagree about what a template contains.
 *
 * It deliberately seeds no users, wallets or workspaces. Those are created by the
 * application; a seed that inserted a fake account with a balance is a balance
 * nobody's tests can reason about.
 */

import { sql } from 'drizzle-orm';
import { FESTIVAL_OCCASIONS, FESTIVAL_TEMPLATE_SEEDS } from '@renderflow/common';

// Resolved from libs/credits' own node_modules, which already links
// @renderflow/db. The script lives here rather than in libs/db precisely because
// pricing is this package's to own: putting it in libs/db would mean libs/db
// depends on libs/credits, and the two would import each other in a cycle.
import { DEFAULT_PRICES } from '../dist/pricing.js';
import { disconnectDb, getDb } from '@renderflow/db';

const db = getDb();

try {
  for (const [action, credits] of Object.entries(DEFAULT_PRICES)) {
    await db.execute(sql`
      INSERT INTO pricing_rules (action, credits, active)
      VALUES (${action}, ${credits}, 1)
      ON CONFLICT (action) DO UPDATE
        SET credits = EXCLUDED.credits,
            active = 1,
            updated_at = now()
    `);
  }

  for (const occasion of FESTIVAL_OCCASIONS) {
    await db.execute(sql`
      INSERT INTO festival_occasions (id, display_name, active)
      VALUES (${occasion.id}, ${occasion.displayName}, true)
      ON CONFLICT (id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            active = true
    `);
  }

  for (const template of FESTIVAL_TEMPLATE_SEEDS) {
    await db.execute(sql`
      INSERT INTO festival_templates
        (id, occasion_id, name, preview_url, slots, color_scheme, audio_track,
         dimensions, reel_duration_seconds, active)
      VALUES (
        ${template.id}, ${template.occasionId}, ${template.name}, ${template.previewUrl},
        ${JSON.stringify(template.slots)}::jsonb,
        ${JSON.stringify(template.colorScheme)}::jsonb,
        ${template.audioTrack},
        ${JSON.stringify(template.dimensions)}::jsonb,
        ${template.reelDurationSeconds},
        true
      )
      ON CONFLICT (id) DO UPDATE
        SET occasion_id = EXCLUDED.occasion_id,
            name = EXCLUDED.name,
            preview_url = EXCLUDED.preview_url,
            slots = EXCLUDED.slots,
            color_scheme = EXCLUDED.color_scheme,
            audio_track = EXCLUDED.audio_track,
            dimensions = EXCLUDED.dimensions,
            reel_duration_seconds = EXCLUDED.reel_duration_seconds,
            active = true
    `);
  }

  const rows = await db.execute(
    sql`SELECT action, credits FROM pricing_rules WHERE active = 1 ORDER BY action`,
  );

  console.log(`seeded ${Object.keys(DEFAULT_PRICES).length} pricing rules`);
  for (const row of rows.rows) {
    console.log(`  ${String(row.action).padEnd(20)} ${String(row.credits).padStart(4)} credits`);
  }
  console.log(
    `seeded ${FESTIVAL_OCCASIONS.length} festival occasions and ` +
      `${FESTIVAL_TEMPLATE_SEEDS.length} templates`,
  );
} catch (error) {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
