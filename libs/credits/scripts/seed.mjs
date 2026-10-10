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
 * It deliberately seeds *nothing else*. Users, wallets and workspaces are created
 * by the application; a seed that inserted a fake account with a balance is a
 * balance nobody's tests can reason about.
 */

import { sql } from 'drizzle-orm';

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

  const rows = await db.execute(
    sql`SELECT action, credits FROM pricing_rules WHERE active = 1 ORDER BY action`,
  );

  console.log(`seeded ${Object.keys(DEFAULT_PRICES).length} pricing rules`);
  for (const row of rows.rows) {
    console.log(`  ${String(row.action).padEnd(20)} ${String(row.credits).padStart(4)} credits`);
  }
} catch (error) {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
