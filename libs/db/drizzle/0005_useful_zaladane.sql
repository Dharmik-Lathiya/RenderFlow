CREATE TABLE "job_checkpoints" (
	"job_id" uuid NOT NULL,
	"stage" "job_stage" NOT NULL,
	"output_ref" varchar(400) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_checkpoints_pkey" PRIMARY KEY("job_id","stage")
);
--> statement-breakpoint
ALTER TABLE "job_checkpoints" ADD CONSTRAINT "job_checkpoints_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;