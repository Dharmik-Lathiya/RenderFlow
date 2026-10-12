#!/usr/bin/env node
/**
 * Keeps `libs/db/drizzle/meta/_journal.json` strictly increasing in `when`.
 *
 * Why this exists: drizzle-kit decides which migrations to apply by comparing
 * the journal's `when` values against the `created_at` of what it has already
 * applied. Hand-edited or generated entries can land OUT OF ORDER, and when that
 * happens drizzle reports "migrations applied successfully" while applying
 * nothing - the new entry's timestamp is behind the last applied one, so it is
 * already considered done.
 *
 * That failure is silent and expensive: it looks exactly like a schema problem.
 * This has been hit twice while building out Phase 7, so the invariant is now
 * enforced by a script rather than remembered.
 *
 * Run after `drizzle-kit generate`:
 *   node scripts/fix-migration-journal.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const journalPath = join(root, 'libs/db/drizzle/meta/_journal.json');

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const entries = journal.entries;

let previousWhen = 0;
let previousIdx = -1;
let changed = 0;

for (const entry of entries) {
  // `idx` only has to INCREASE. It is not positional: this journal has a real
  // gap (no 0002), because that migration was never generated under that name.
  if (entry.idx <= previousIdx) {
    console.error(`entry ${entry.tag} has idx ${entry.idx}, not after ${previousIdx}`);
    process.exit(1);
  }
  previousIdx = entry.idx;

  // Strictly increasing in `when`, which is what drizzle actually compares.
  // Spacing of a second is plenty - drizzle only orders by it.
  if (entry.when <= previousWhen) {
    entry.when = previousWhen + 1_000;
    changed += 1;
    console.log(`  ${entry.tag}: when -> ${entry.when} (was out of order)`);
  }

  previousWhen = entry.when;
}

writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

console.log(
  changed === 0
    ? `journal already in order (${entries.length} entries)`
    : `reordered ${changed} of ${entries.length} entries`,
);
