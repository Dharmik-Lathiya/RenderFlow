import { assertBillingIsSafe } from './billing';

/**
 * The stub top-up mints credits, so it must be impossible to enable in
 * production by leaving a development default in place.
 */
describe('assertBillingIsSafe', () => {
  it('refuses the stub provider in production', () => {
    expect(() => assertBillingIsSafe({ nodeEnv: 'production', provider: 'stub' })).toThrow(
      /BILLING_PROVIDER=stub/,
    );
  });

  it('allows the stub provider outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() => assertBillingIsSafe({ nodeEnv, provider: 'stub' })).not.toThrow();
    }
  });

  it('allows disabled billing everywhere', () => {
    expect(() =>
      assertBillingIsSafe({ nodeEnv: 'production', provider: 'disabled' }),
    ).not.toThrow();
  });
});
