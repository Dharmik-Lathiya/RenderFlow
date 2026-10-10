-- Column defaults for databases created before Drizzle.
--
-- Under Prisma, `users.id`, `users.updated_at` and the other id/timestamp
-- columns had NO database default: the Prisma client generated those values in
-- application code. Drizzle relies on `gen_random_uuid()` and `now()` instead,
-- so an adopted database must gain them before the API can insert a row that
-- omits them.
--
-- Every statement is an unconditional `SET DEFAULT`, which makes this migration
-- safe on a fresh database too - the defaults are already correct there, and
-- setting them again is a no-op. That is the point: it means a legacy database
-- and a new one converge on the same schema through the same command, with no
-- branching in the deploy procedure.
--
-- `created_at` already had `CURRENT_TIMESTAMP` under Prisma, which is the same
-- transaction timestamp `now()` produces. It is normalised here anyway so that an
-- adopted database and a fresh one differ in nothing a schema diff can see.

ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();

ALTER TABLE "wallets" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "wallets" ALTER COLUMN "created_at" SET DEFAULT now();

ALTER TABLE "credit_ledger" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "credit_ledger" ALTER COLUMN "created_at" SET DEFAULT now();

ALTER TABLE "refresh_sessions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "refresh_sessions" ALTER COLUMN "created_at" SET DEFAULT now();