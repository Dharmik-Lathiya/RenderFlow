/**
 * Billing configuration that must fail at boot, not at the first click.
 *
 * There is no payment provider integration yet. The `stub` provider exists so the
 * `PURCHASE` ledger path can be exercised locally and by the demo, and it is
 * exactly the kind of switch that must not survive into production: it grants
 * credits without taking money.
 */

export type BillingProvider = 'disabled' | 'stub';

export function assertBillingIsSafe(options: { nodeEnv: string; provider: BillingProvider }): void {
  if (options.nodeEnv === 'production' && options.provider === 'stub') {
    throw new Error(
      'BILLING_PROVIDER=stub credits accounts without a payment and is refused in production. ' +
        'Set BILLING_PROVIDER=disabled until a real provider is wired to libs/credits#purchase.',
    );
  }
}
