/**
 * @renderflow/credits
 *
 * THE ONLY MODULE ALLOWED TO WRITE `wallets` OR `credit_ledger`
 * (AGENTS.md rule 1, highest priority).
 *
 * Invariants enforced here:
 *   - signup bonus granted exactly once, in the user-creation transaction;
 *   - integer credits only, never floats;
 *   - every movement is an append-only ledger row;
 *   - idempotency keys make reserve/capture/refund safe under retries;
 *   - balances are caches, and `reconcile*` proves they match the ledger.
 *
 * Anything that needs to change a balance goes through this API. If another
 * module finds itself wanting raw SQL against these tables, that is a bug.
 */

export * from './balance';
export * from './signup-bonus';
export {
  assertIntegerCredits,
  CreditError,
  signupBonusCredits,
  REFERENCE_TYPES,
  type CreditEntryType,
  type CreditTransaction,
  type GrantSignupBonusInput,
  type LedgerEntry,
  type ReferenceType,
} from './signup-bonus';
export {
  getBalance,
  reconcileAll,
  reconcileUser,
  type LedgerPage,
  type ReconcileReport,
  type WalletBalance,
} from './balance';
