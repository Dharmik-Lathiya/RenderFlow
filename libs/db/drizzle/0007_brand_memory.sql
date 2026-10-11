CREATE TABLE "brand_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" varchar(40) DEFAULT 'post' NOT NULL,
	"content" text NOT NULL,
	-- Phase 6 stores the embedding as JSON rather than `vector`.
	--
	-- pgvector is not available in this environment and the image ships no
	-- extension for it, so a `vector` column could neither be created nor tested
	-- here. For a brand's approved posts - dozens to low hundreds - a cosine
	-- ranking in SQL is fast enough, and the store sits behind `VectorStore` so
	-- the pgvector backend is one class to add once the extension exists rather
	-- than a rewrite. The production migration is written down in
	-- `libs/ai/src/brand-memory.ts`.
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_memory" ADD CONSTRAINT "brand_memory_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "brand_memory_brand_id_idx" ON "brand_memory" USING btree ("brand_id");