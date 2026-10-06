-- Credit invariants that Prisma's schema language cannot express.
--
-- AGENTS.md rule 4: every ledger insert carries (reference_type, reference_id,
-- entry_type) with a unique constraint to guarantee idempotency. This is what
-- makes a double refund (reaper racing a worker) a no-op rather than a duplicate
-- credit grant.
--
-- NULLs do not collide in a unique index, so SYSTEM entries (reference_type IS
-- NULL, e.g. the signup bonus) are unaffected by this constraint.

-- Idempotency key for reserve/capture/refund/adjustment entries.
CREATE UNIQUE INDEX "credit_ledger_reference_key"
  ON "credit_ledger" ("reference_type", "reference_id", "entry_type")
  WHERE "reference_type" IS NOT NULL;

-- PROJECT.md section 5.1 rule 1: the signup bonus is granted exactly once per
-- user. A partial unique index (not a plain unique on user_id+entry_type) so a
-- user may still have many RESERVE rows.
CREATE UNIQUE INDEX "credit_ledger_signup_bonus_once"
  ON "credit_ledger" ("user_id")
  WHERE "entry_type" = 'SIGNUP_BONUS';

-- AGENTS.md rule 5: wallet columns have CHECK (available >= 0 AND reserved >= 0).
-- The database is the last line of defence; a buggy balance write is rejected
-- instead of silently trusted.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_available_non_negative" CHECK ("available" >= 0);

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_reserved_non_negative" CHECK ("reserved" >= 0);
