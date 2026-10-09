import { eq } from 'drizzle-orm';

import { GENERATION_KINDS, type GenerationKind } from '@renderflow/common';
import { pricingRules } from '@renderflow/db';

import { CreditError, type CreditTransaction } from './signup-bonus';

/**
 * Server-side pricing (PROJECT.md section 5.2, AGENTS.md rule 7: "Costs come
 * from the server, never from the client").
 *
 * Prices live in `pricing_rules`, not in code, so changing one is a data change
 * and a charge can be audited against the rate that was in force when it
 * happened. `DEFAULT_PRICES` exists only to seed an empty table - the lookup
 * never falls back to it, because a missing price must fail loudly rather than
 * silently charge a default.
 */
export const DEFAULT_PRICES: Readonly<Record<GenerationKind, number>> = {
  CONTENT_PLAN: 2,
  CAPTION: 1,
  POSTER: 5,
  CAROUSEL: 15,
  REEL: 30,
  REGENERATE_SCENE: 8,
  TRANSLATION: 1,
};

export interface PriceQuote {
  action: GenerationKind;
  /** Integer credits. */
  credits: number;
}

/**
 * Looks up the price for an action.
 *
 * Throws `PRICING_UNAVAILABLE` when the row is missing or inactive. Reserving
 * against a guessed price is how a customer ends up charged the wrong amount
 * with no record of why, so an unpriced action is a server error, not a zero.
 */
export async function priceFor(tx: CreditTransaction, action: GenerationKind): Promise<PriceQuote> {
  const rows = await tx
    .select({
      action: pricingRules.action,
      credits: pricingRules.credits,
      active: pricingRules.active,
    })
    .from(pricingRules)
    .where(eq(pricingRules.action, action))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    throw new CreditError(
      `No pricing rule for "${action}". Add a pricing_rules row before allowing this action.`,
      'PRICING_UNAVAILABLE',
    );
  }

  if (row.active !== 1) {
    throw new CreditError(
      `Pricing rule "${action}" is inactive and cannot be charged.`,
      'PRICING_UNAVAILABLE',
    );
  }

  if (!Number.isInteger(row.credits) || row.credits < 0) {
    // The CHECK constraint makes this unreachable, but the failure would then be
    // an opaque constraint violation from deep in a transaction. Naming the
    // actual problem here is cheaper to diagnose than to rediscover later.
    throw new CreditError(
      `Pricing rule "${action}" has a non-integer or negative price (${row.credits}).`,
      'PRICING_UNAVAILABLE',
    );
  }

  return { action, credits: row.credits };
}

/** Reads every price, for `GET /credits/pricing` and admin screens. */
export async function listPrices(tx: CreditTransaction): Promise<PriceQuote[]> {
  const rows: Array<{ action: string; credits: number }> = await tx
    .select({ action: pricingRules.action, credits: pricingRules.credits })
    .from(pricingRules);
  return rows.map((row) => ({ action: row.action as GenerationKind, credits: row.credits }));
}

/**
 * Validates that every known action has a price.
 *
 * A gap is invisible until a user hits the missing action and gets a 500, so it
 * is worth failing at boot or in a health check instead.
 */
export function assertPricingComplete(quotes: readonly PriceQuote[]): void {
  const priced = new Set(quotes.map((quote) => quote.action));
  const missing = GENERATION_KINDS.filter((kind) => !priced.has(kind));

  if (missing.length > 0) {
    throw new CreditError(
      `pricing_rules is missing an entry for: ${missing.join(', ')}`,
      'PRICING_UNAVAILABLE',
    );
  }
}

/** Total cost of a set of items. Integer credits throughout. */
export function sumQuotes(quotes: readonly PriceQuote[]): number {
  return quotes.reduce((total, quote) => total + quote.credits, 0);
}
