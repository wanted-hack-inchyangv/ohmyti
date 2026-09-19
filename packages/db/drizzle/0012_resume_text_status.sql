CREATE TYPE "public"."resume_text_status" AS ENUM('NONE', 'EXTRACTED', 'IMAGE_ONLY', 'MANUAL');--> statement-breakpoint
ALTER TABLE "submission_context" ADD COLUMN "resume_text_status" "resume_text_status" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_context" ADD COLUMN "resume_text_reason" text;