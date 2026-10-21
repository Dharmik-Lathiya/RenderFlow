CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity" varchar(40) NOT NULL,
	"entity_id" varchar(64),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publish_job_id" uuid NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_metrics_non_negative" CHECK ("post_metrics"."likes" >= 0 AND "post_metrics"."comments" >= 0 AND "post_metrics"."reach" >= 0 AND "post_metrics"."clicks" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_publish_job_id_publish_jobs_id_fk" FOREIGN KEY ("publish_job_id") REFERENCES "public"."publish_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_metrics_job_fetched_idx" ON "post_metrics" USING btree ("publish_job_id","fetched_at");--> statement-breakpoint
CREATE INDEX "post_metrics_fetched_at_idx" ON "post_metrics" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "posts_scheduled_at_idx" ON "posts" USING btree ("scheduled_at") WHERE "posts"."scheduled_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "publish_jobs_metrics_idx" ON "publish_jobs" USING btree ("published_at") WHERE "publish_jobs"."status" = 'PUBLISHED' AND "publish_jobs"."external_post_id" IS NOT NULL;