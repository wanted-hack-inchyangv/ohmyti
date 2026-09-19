CREATE TYPE "public"."ai_review_kind" AS ENUM('RUBRIC_DRAFT', 'MUTATION_TARGETS', 'EVIDENCE_REVIEW', 'CONTEXT_LINK');--> statement-breakpoint
CREATE TYPE "public"."assignment_version_status" AS ENUM('DRAFT', 'VALIDATING', 'APPROVED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."context_status" AS ENUM('EVIDENCE_FOUND', 'NEEDS_CHECK', 'NO_DATA');--> statement-breakpoint
CREATE TYPE "public"."execution_record_kind" AS ENUM('HARNESS', 'SUBMITTED_TESTS', 'MUTATION_VALIDATION', 'MUTATION_TESTS', 'RERUN');--> statement-breakpoint
CREATE TYPE "public"."failure_kind" AS ENUM('NONE', 'ASSERTION', 'SUBMISSION', 'ENVIRONMENT', 'TIMEOUT');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('EVALUATE_SUBMISSION', 'RERUN_EXECUTION', 'VALIDATE_ASSIGNMENT', 'MUTATION_EXPERIMENT', 'CONTEXT_LINK', 'DELETE_SUBMISSION');--> statement-breakpoint
CREATE TYPE "public"."method" AS ENUM('EXECUTION', 'STATIC', 'MUTATION', 'HUMAN_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."mutation_outcome" AS ENUM('KILLED', 'SURVIVED', 'EQUIVALENT', 'BUILD_FAIL', 'ENV_ERROR', 'TIMEOUT', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('NOT_REQUIRED', 'PENDING', 'CONFIRMED');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('RECEIVED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNSUPPORTED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."validation_sample_kind" AS ENUM('CORRECT', 'ALTERNATIVE', 'DEFECTIVE', 'ADVERSARIAL');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('PASS', 'FAIL', 'PARTIAL', 'INCONCLUSIVE');--> statement-breakpoint
CREATE TABLE "ai_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ai_review_kind" NOT NULL,
	"evaluation_id" uuid,
	"assignment_version_id" uuid,
	"submission_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_digest" text NOT NULL,
	"output" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_reviews_version_positive" CHECK ("ai_reviews"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assignment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "assignment_version_status" DEFAULT 'DRAFT' NOT NULL,
	"title" text NOT NULL,
	"spec_ref" text NOT NULL,
	"spec_digest" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"rubric_version" text NOT NULL,
	"execution_contract" jsonb NOT NULL,
	"harness_version" text NOT NULL,
	"validation_result" jsonb,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_versions_version_positive" CHECK ("assignment_versions"."version" >= 1),
	CONSTRAINT "assignment_versions_approved_consistent" CHECK (("assignment_versions"."status" <> 'APPROVED') OR ("assignment_versions"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"status" "context_status" NOT NULL,
	"github_evidence" jsonb,
	"assignment_observation" jsonb,
	"follow_up_question" text,
	"ai_review_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "criterion_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"rubric_version" text NOT NULL,
	"max_points" integer NOT NULL,
	"earned_points" integer,
	"verdict" "verdict" NOT NULL,
	"method" "method" NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}' NOT NULL,
	"issue_id" text,
	"observation" text NOT NULL,
	"interpretation" text,
	"review_state" "review_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "criterion_results_max_points_nonneg" CHECK ("criterion_results"."max_points" >= 0),
	CONSTRAINT "criterion_results_earned_range" CHECK ("criterion_results"."earned_points" IS NULL OR ("criterion_results"."earned_points" >= 0 AND "criterion_results"."earned_points" <= "criterion_results"."max_points")),
	CONSTRAINT "criterion_results_deduction_requires_evidence" CHECK ("criterion_results"."earned_points" IS NULL OR "criterion_results"."earned_points" >= "criterion_results"."max_points" OR cardinality("criterion_results"."evidence_ids") > 0),
	CONSTRAINT "criterion_results_inconclusive_is_null" CHECK ("criterion_results"."verdict" <> 'INCONCLUSIVE' OR "criterion_results"."earned_points" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "deletion_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"requested_by" text,
	"removed" jsonb NOT NULL,
	"reason" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"assignment_version_id" uuid NOT NULL,
	"rubric_version" text NOT NULL,
	"harness_version" text NOT NULL,
	"environment_digest" text NOT NULL,
	"submission_sha" text NOT NULL,
	"stage_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score_earned" integer,
	"score_min" integer,
	"score_max" integer,
	"pending_points" integer,
	"is_sample" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "evaluations_score_range" CHECK (("evaluations"."score_min" IS NULL AND "evaluations"."score_max" IS NULL) OR ("evaluations"."score_min" <= "evaluations"."score_max"))
);
--> statement-breakpoint
CREATE TABLE "evidences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"submission_sha" text NOT NULL,
	"source" jsonb,
	"run_id" uuid,
	"test_id" text,
	"artifact_refs" text[] DEFAULT '{}' NOT NULL,
	"snippet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"kind" "execution_record_kind" NOT NULL,
	"submission_sha" text NOT NULL,
	"rubric_version" text NOT NULL,
	"harness_version" text NOT NULL,
	"environment_digest" text NOT NULL,
	"patch_digest" text,
	"seed" text,
	"input_ref" text NOT NULL,
	"expected_ref" text NOT NULL,
	"actual_ref" text NOT NULL,
	"exit_code" integer,
	"failure_kind" "failure_kind" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "job_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_attempts_nonneg" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mutation_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"mutation_id" text NOT NULL,
	"group_id" text NOT NULL,
	"target_criterion_id" text NOT NULL,
	"target" jsonb,
	"patch_digest" text,
	"patch_ref" text,
	"outcome" "mutation_outcome" NOT NULL,
	"validation_record_id" uuid,
	"test_record_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"criterion_result_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"reviewer" text NOT NULL,
	"previous" jsonb NOT NULL,
	"next" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_context" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"resume_ref" text,
	"resume_text" text,
	"github_login" text,
	"github_profile" jsonb,
	"analysis_scope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_version_id" uuid NOT NULL,
	"repo_url" text NOT NULL,
	"repo_ref" text,
	"submission_sha" text,
	"snapshot_ref" text,
	"status" "submission_status" DEFAULT 'RECEIVED' NOT NULL,
	"unsupported_reason" text,
	"is_sample" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "submissions_sha_format" CHECK ("submissions"."submission_sha" IS NULL OR "submissions"."submission_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "validation_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "validation_sample_kind" NOT NULL,
	"snapshot_ref" text NOT NULL,
	"submission_sha" text NOT NULL,
	"expected" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD CONSTRAINT "assignment_versions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_links" ADD CONSTRAINT "context_links_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_run_id_execution_records_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."execution_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_records" ADD CONSTRAINT "execution_records_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_experiments" ADD CONSTRAINT "mutation_experiments_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_experiments" ADD CONSTRAINT "mutation_experiments_validation_record_id_execution_records_id_fk" FOREIGN KEY ("validation_record_id") REFERENCES "public"."execution_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_experiments" ADD CONSTRAINT "mutation_experiments_test_record_id_execution_records_id_fk" FOREIGN KEY ("test_record_id") REFERENCES "public"."execution_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_criterion_result_id_criterion_results_id_fk" FOREIGN KEY ("criterion_result_id") REFERENCES "public"."criterion_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_context" ADD CONSTRAINT "submission_context_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_samples" ADD CONSTRAINT "validation_samples_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_reviews_evaluation_kind_idx" ON "ai_reviews" USING btree ("evaluation_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_versions_assignment_version_idx" ON "assignment_versions" USING btree ("assignment_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_versions_rubric_version_idx" ON "assignment_versions" USING btree ("rubric_version");--> statement-breakpoint
CREATE INDEX "context_links_submission_idx" ON "context_links" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "criterion_results_evaluation_criterion_idx" ON "criterion_results" USING btree ("evaluation_id","criterion_id");--> statement-breakpoint
CREATE INDEX "evaluations_submission_idx" ON "evaluations" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "evidences_evaluation_idx" ON "evidences" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "evidences_run_idx" ON "evidences" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "execution_records_evaluation_idx" ON "execution_records" USING btree ("evaluation_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_active_idx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" IN ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "mutation_experiments_evaluation_mutation_idx" ON "mutation_experiments" USING btree ("evaluation_id","mutation_id");--> statement-breakpoint
CREATE INDEX "review_events_evaluation_idx" ON "review_events" USING btree ("evaluation_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_version_status_idx" ON "submissions" USING btree ("assignment_version_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_samples_version_name_idx" ON "validation_samples" USING btree ("assignment_version_id","name");