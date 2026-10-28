import { purchase } from './purchase';
import { CreditError, type CreditTransaction } from './signup-bonus';

/**
 * Input validation for the PURCHASE path.
 *
 * These cases reject before the transaction is touched, so they run without a
 * database. The idempotency guarantee itself - one ledger row per provider
 * reference - is a database constraint and is asserted against real Postgres in
 * `tests/integration/credit-engine.spec.ts`; it cannot be proven with a mock.
 */
describe('purchase', () => {
  const neverTouched = {
    insert: () => {
      throw new Error('the transaction must not be used for an invalid purchase');
    },
  } as unknown as CreditTransaction;

  const base = { userId: 'user-1', referenceId: 'order-1', provider: 'stub' };

  it('refuses a zero-credit purchase', async () => {
    // Nothing was paid for, so nothing should be credited - and a zero row would
    // put a meaningless movement in an append-only ledger.
    await expect(purchase(neverTouched, { ...base, credits: 0 })).rejects.toThrow(CreditError);
  });

  it('refuses a fractional or negative amount', async () => {
    await expect(purchase(neverTouched, { ...base, credits: 1.5 })).rejects.toThrow(CreditError);
    await expect(purchase(neverTouched, { ...base, credits: -5 })).rejects.toThrow(CreditError);
  });

  it('refuses a purchase without a provider reference', async () => {
    // Without a reference there is no idempotency key, so a retried webhook
    // credits the wallet again.
    await expect(
      purchase(neverTouched, { ...base, referenceId: '   ', credits: 10 }),
    ).rejects.toThrow(CreditError);
  });
});
