CREATE TABLE "festival_occasions" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"icon_url" text,
	"active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "festival_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"occasion_id" text NOT NULL,
	"name" text NOT NULL,
	"preview_url" text NOT NULL,
	"slots" jsonb NOT NULL,
	"color_scheme" jsonb NOT NULL,
	"audio_track" text,
	"dimensions" jsonb NOT NULL,
	"reel_duration_seconds" integer,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "festival_templates" ADD CONSTRAINT "festival_templates_occasion_id_festival_occasions_id_fk" FOREIGN KEY ("occasion_id") REFERENCES "public"."festival_occasions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_sessions_family_id_idx" ON "refresh_sessions" USING btree ("family_id");