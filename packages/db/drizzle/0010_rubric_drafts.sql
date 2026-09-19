-- T-406: AI 채점 기준 초안 요청. DRAFT_RUBRIC job이 워커에서 LLM을 호출해 rubric_drafts 행을 채운다.
ALTER TYPE "public"."job_type" ADD VALUE 'DRAFT_RUBRIC';--> statement-breakpoint
CREATE TABLE "rubric_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid,
	"spec_ref" text NOT NULL,
	"spec_digest" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"rubric" jsonb,
	"validation_errors" jsonb,
	"notes" jsonb,
	"dropped_mutation_ids" jsonb,
	"failure_code" text,
	"failure_message" text,
	"ai_review_id" uuid,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "rubric_drafts_status_valid" CHECK ("rubric_drafts"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "rubric_drafts_succeeded_has_rubric" CHECK ("rubric_drafts"."status" <> 'SUCCEEDED' or ("rubric_drafts"."rubric" is not null and "rubric_drafts"."validation_errors" is not null and "rubric_drafts"."finished_at" is not null)),
	CONSTRAINT "rubric_drafts_failed_has_reason" CHECK ("rubric_drafts"."status" <> 'FAILED' or ("rubric_drafts"."failure_code" is not null and "rubric_drafts"."failure_message" is not null and "rubric_drafts"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "rubric_drafts" ADD CONSTRAINT "rubric_drafts_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_drafts" ADD CONSTRAINT "rubric_drafts_ai_review_id_ai_reviews_id_fk" FOREIGN KEY ("ai_review_id") REFERENCES "public"."ai_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rubric_drafts_assignment_idx" ON "rubric_drafts" USING btree ("assignment_id","created_at");