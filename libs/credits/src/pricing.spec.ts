import { DEFAULT_PRICES, assertPricingComplete, sumQuotes } from './pricing';
import { CreditError } from './signup-bonus';

/**
 * Pure pricing logic.
 *
 * The database half (`priceFor`) is covered in tests/integration, because
 * "an action with no price row" is only meaningful against a real table.
 * What is checked here is the arithmetic and the failure messages.
 */
describe('DEFAULT_PRICES', () => {
  it('matches PROJECT.md section 5.2', () => {
    // Pinned against the spec rather than against the previous value, so a
    // price change has to be a deliberate edit here and in pricing_rules.
    expect(DEFAULT_PRICES).toEqual({
      CONTENT_PLAN: 2,
      CAPTION: 1,
      POSTER: 5,
      CAROUSEL: 15,
      REEL: 30,
      REGENERATE_SCENE: 8,
      TRANSLATION: 1,
    });
  });

  it('prices integers only, because credits are integers', () => {
    for (const [action, credits] of Object.entries(DEFAULT_PRICES)) {
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBeGreaterThan(0);
      expect(`${action}`).toEqual(expect.any(String));
    }
  });

  it('makes 50 free credits cover about one reel plus captions', () => {
    // The spec's own sanity check on the bonus size: if a reel cost much less
    // than the bonus, the pricing would be decorative.
    const reelPlusThreeCaptions = DEFAULT_PRICES.REEL + DEFAULT_PRICES.CAPTION * 3;
    expect(reelPlusThreeCaptions).toBeLessThanOrEqual(50);
    expect(DEFAULT_PRICES.POSTER * 10).toBeLessThanOrEqual(50);
  });
});

describe('sumQuotes', () => {
  it('adds a set of items', () => {
    expect(
      sumQuotes([
        { action: 'REEL', credits: 30 },
        { action: 'CAPTION', credits: 1 },
        { action: 'CAPTION', credits: 1 },
      ]),
    ).toBe(32);
  });

  it('returns zero for an empty set', () => {
    expect(sumQuotes([])).toBe(0);
  });

  it('stays an integer when every item is an integer', () => {
    expect(
      Number.isInteger(
        sumQuotes([
          { action: 'POSTER', credits: 5 },
          { action: 'CAROUSEL', credits: 15 },
        ]),
      ),
    ).toBe(true);
  });
});

describe('assertPricingComplete', () => {
  const allQuotes = (): Array<{ action: keyof typeof DEFAULT_PRICES; credits: number }> =>
    Object.entries(DEFAULT_PRICES).map(([action, credits]) => ({
      action: action as keyof typeof DEFAULT_PRICES,
      credits,
    }));

  it('passes when every action has a price', () => {
    expect(() => assertPricingComplete(allQuotes())).not.toThrow();
  });

  it('fails loudly when an action has no price', () => {
    // A gap is invisible until a user hits that action and gets a 500. Failing
    // at boot or in a health check is much cheaper than finding out in production.
    const incomplete = allQuotes().filter((quote) => quote.action !== 'REEL');

    expect(() => assertPricingComplete(incomplete)).toThrow(CreditError);
    expect(() => assertPricingComplete(incomplete)).toThrow(/REEL/);
  });

  it('names every missing action at once', () => {
    const partial = allQuotes().filter(
      (quote) => quote.action !== 'REEL' && quote.action !== 'CAROUSEL',
    );

    // One restart per missing rule would be a miserable loop to debug. The
    // expected order follows GENERATION_KINDS, not the input order, so the
    // message is stable regardless of how the rows came back from the database.
    expect(() => assertPricingComplete(partial)).toThrow(/CAROUSEL, REEL/);
  });

  it('treats an empty table as incomplete', () => {
    expect(() => assertPricingComplete([])).toThrow(CreditError);
  });
});
