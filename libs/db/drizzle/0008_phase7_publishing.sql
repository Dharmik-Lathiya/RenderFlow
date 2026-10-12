CREATE TYPE "public"."notification_type" AS ENUM('publish_failed', 'publish_succeeded', 'credit_refunded', 'credits_low');--> statement-breakpoint
CREATE TYPE "public"."publish_status" AS ENUM('PENDING', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('linkedin', 'instagram');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"status" "publish_status" DEFAULT 'PENDING' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"platform_content" text NOT NULL,
	"media_key" varchar(400),
	"idempotency_key" varchar(200),
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"worker_id" varchar(100),
	"heartbeat_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"external_post_id" varchar(300),
	"external_url" text,
	"error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_attempts_non_negative" CHECK ("publish_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" "social_platform" NOT NULL,
	"external_account_id" varchar(200) NOT NULL,
	"display_name" varchar(200),
	"token" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_jobs_idempotency_key" ON "publish_jobs" USING btree ("idempotency_key") WHERE "publish_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_jobs_post_account_idx" ON "publish_jobs" USING btree ("post_id","social_account_id");--> statement-breakpoint
CREATE INDEX "publish_jobs_due_idx" ON "publish_jobs" USING btree ("scheduled_for") WHERE "publish_jobs"."status" IN ('PENDING','SCHEDULED');--> statement-breakpoint
CREATE INDEX "publish_jobs_reclaim_idx" ON "publish_jobs" USING btree ("status","locked_until") WHERE "publish_jobs"."status" IN ('PENDING','SCHEDULED','PUBLISHING');--> statement-breakpoint
CREATE INDEX "publish_jobs_external_post_id_idx" ON "publish_jobs" USING btree ("external_post_id") WHERE "publish_jobs"."external_post_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_workspace_platform_external_idx" ON "social_accounts" USING btree ("workspace_id","platform","external_account_id");--> statement-breakpoint
CREATE INDEX "social_accounts_workspace_id_idx" ON "social_accounts" USING btree ("workspace_id");