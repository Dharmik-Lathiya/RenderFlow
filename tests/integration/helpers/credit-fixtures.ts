import { sql } from 'drizzle-orm';

import { DEFAULT_PRICES } from '../../../libs/credits/src/pricing';
import { generationJobs, outboxEvents, pricingRules } from '@renderflow/db';
import type { GenerationKind } from '@renderflow/common';

import type { TestDb } from './test-database';

/**
 * Fixtures for the credit engine suites.
 *
 * Pricing lives in `pricing_rules` (PROJECT.md section 5.2), so a test that
 * needs a job to cost something seeds a price the way production does. Nothing
 * here writes `wallets` or `credit_ledger` directly: those are
 * `libs/credits`' exclusive responsibility (AGENTS.md rule 1), and a fixture that
 * bypassed it could pass while violating the invariant under test.
 */
export async function seedPricing(
  db: TestDb,
  overrides: Partial<Record<GenerationKind, number>> = {},
): Promise<void> {
  const rows = Object.entries({ ...DEFAULT_PRICES, ...overrides }).map(([action, credits]) => ({
    action,
    credits,
    active: 1,
  }));

  // Replace rather than upsert. `pricing_rules` is deliberately NOT truncated by
  // `truncateAll` (prices are configuration, not per-test state), so a suite that
  // deactivates or deletes a rule would otherwise leak that into the next test
  // and fail somewhere unrelated.
  await db.delete(pricingRules);

  await db.insert(pricingRules).values(rows);
}

/** Sets one price, leaving the rest of the table alone. */
export async function seedPrice(
  db: TestDb,
  action: GenerationKind,
  credits: number,
): Promise<void> {
  await db
    .insert(pricingRules)
    .values({ action, credits, active: 1 })
    // `active` too: a rule deactivated by an earlier test must come back, or the
    // next test fails on state it did not set.
    .onConflictDoUpdate({ target: pricingRules.action, set: { credits, active: 1 } });
}

export async function deactivatePrice(db: TestDb, action: GenerationKind): Promise<void> {
  await db
    .update(pricingRules)
    .set({ active: 0 })
    .where(sql`${pricingRules.action} = ${action}`);
}

/** Jobs for a user, newest first. */
export async function jobsOf(
  db: TestDb,
  userId: string,
): Promise<
  Array<{ id: string; status: string; creditsReserved: number; refunded: number; captured: number }>
> {
  return db
    .select({
      id: generationJobs.id,
      status: generationJobs.status,
      creditsReserved: generationJobs.creditsReserved,
      refunded: generationJobs.refunded,
      captured: generationJobs.captured,
    })
    .from(generationJobs)
    .where(sql`${generationJobs.userId} = ${userId}::uuid`)
    .orderBy(sql`${generationJobs.createdAt} ASC`);
}

export async function jobCount(db: TestDb): Promise<number> {
  const rows = await db.select({ id: generationJobs.id }).from(generationJobs);
  return rows.length;
}

/** Unprocessed outbox rows, i.e. what the relay would pick up next. */
export async function pendingOutbox(
  db: TestDb,
): Promise<Array<{ eventType: string; aggregateId: string }>> {
  return db
    .select({ eventType: outboxEvents.eventType, aggregateId: outboxEvents.aggregateId })
    .from(outboxEvents)
    .where(sql`${outboxEvents.processedAt} IS NULL`);
}

export async function outboxCount(db: TestDb): Promise<number> {
  const rows = await db.select({ id: outboxEvents.id }).from(outboxEvents);
  return rows.length;
}
