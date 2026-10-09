import { assertIntegerCredits, CreditError } from './signup-bonus';

/**
 * Guards that hold regardless of database state.
 *
 * The transaction semantics of `reserve`/`refund`/`capture` live in
 * tests/integration/credit-engine.spec.ts, because they are enforced by
 * Postgres (guarded UPDATE row counts, unique indexes, CHECK constraints) and a
 * fake database would assert nothing about any of it.
 *
 * What is unit-testable here is the input contract: the cheap rejections that
 * must happen before any statement runs.
 */
describe('reserve input contract', () => {
  it('rejects a fractional cost before touching the wallet', () => {
    // A non-integer cost would break the exactness of the ledger sum, and the
    // rejection is far cheaper here than after a wallet update.
    expect(() => assertIntegerCredits(2.5, 'reservation cost')).toThrow(CreditError);
    expect(() => assertIntegerCredits(2.5, 'reservation cost')).toThrow(/integer/);
  });

  it('rejects a negative cost', () => {
    // A negative reservation would MINT credits: available goes up, reserved goes
    // down. The CHECK constraints do not stop it because both stay non-negative.
    expect(() => assertIntegerCredits(-30, 'reservation cost')).toThrow(/negative/);
  });

  it('accepts a zero cost, which is legitimate', () => {
    // A free action is a real case: it should reserve nothing and still create a
    // job, so rejecting zero would break publishing and scheduling being free.
    expect(() => assertIntegerCredits(0, 'reservation cost')).not.toThrow();
  });

  it('accepts the largest prices in the table', () => {
    for (const cost of [1, 5, 15, 30, 50, 8]) {
      expect(() => assertIntegerCredits(cost, 'reservation cost')).not.toThrow();
    }
  });
});
