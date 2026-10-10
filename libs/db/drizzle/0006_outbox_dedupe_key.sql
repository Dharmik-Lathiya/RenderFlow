ALTER TABLE "outbox_events" ADD COLUMN "dedupe_key" varchar(200);

-- Backfill with the identity the old unique index encoded, so history keeps its
-- dedupe guarantee while the column is filled.
UPDATE "outbox_events"
   SET "dedupe_key" = "aggregate_type" || ':' || "aggregate_id" || ':' || "event_type";

ALTER TABLE "outbox_events" ALTER COLUMN "dedupe_key" SET NOT NULL;

DROP INDEX IF EXISTS "outbox_events_dedupe_idx";

-- One row per logical event. Replaces the (aggregate_type, aggregate_id,
-- event_type) index, which could not express "the same job at five different
-- stages is five events" - stage two was a unique-constraint violation.
CREATE UNIQUE INDEX "outbox_events_dedupe_idx" ON "outbox_events" USING btree ("dedupe_key");