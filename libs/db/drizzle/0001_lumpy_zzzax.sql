CREATE TYPE "public"."job_stage" AS ENUM('PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"post_id" uuid,
	"kind" varchar(40) NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"stage" "job_stage" DEFAULT 'PLAN' NOT NULL,
	"credits_reserved" integer NOT NULL,
	"refunded" integer DEFAULT 0 NOT NULL,
	"captured" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"worker_id" varchar(100),
	"heartbeat_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"idempotency_key" varchar(200),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_credits_non_negative" CHECK ("generation_jobs"."credits_reserved" >= 0),
	CONSTRAINT "generation_jobs_attempts_non_negative" CHECK ("generation_jobs"."attempts" >= 0),
	CONSTRAINT "generation_jobs_not_captured_and_refunded" CHECK (NOT ("generation_jobs"."captured" = 1 AND "generation_jobs"."refunded" = 1))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(40) NOT NULL,
	"aggregate_id" varchar(64) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"action" varchar(40) PRIMARY KEY NOT NULL,
	"credits" integer NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_rules_credits_non_negative" CHECK ("pricing_rules"."credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_user_idempotency_key" ON "generation_jobs" USING btree ("user_id","idempotency_key") WHERE "generation_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generation_jobs_reclaim_idx" ON "generation_jobs" USING btree ("status","locked_until") WHERE "generation_jobs"."status" IN ('PENDING','PROCESSING');--> statement-breakpoint
CREATE INDEX "generation_jobs_user_id_created_at_idx" ON "generation_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_dedupe_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id","event_type");--> statement-breakpoint
CREATE INDEX "pricing_rules_active_idx" ON "pricing_rules" USING btree ("active");