ALTER TYPE "public"."social_platform" ADD VALUE 'facebook';--> statement-breakpoint
ALTER TYPE "public"."social_platform" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TABLE "festival_occasions" ADD COLUMN "country" text DEFAULT 'GLOBAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "festival_occasions" ADD COLUMN "featured_date" date;
