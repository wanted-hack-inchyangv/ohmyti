ALTER TABLE "jobs" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
-- 이전 이름을 T-006에서 확정한 이름으로 옮긴다. 별도 job이던 mutation·맥락 연결은 EVALUATE_SUBMISSION 단계로 흡수한다.
UPDATE "jobs" SET "type" = 'VALIDATE_RUBRIC' WHERE "type" = 'VALIDATE_ASSIGNMENT';--> statement-breakpoint
UPDATE "jobs" SET "type" = 'EVALUATE_SUBMISSION' WHERE "type" IN ('MUTATION_EXPERIMENT', 'CONTEXT_LINK');--> statement-breakpoint
DROP TYPE "public"."job_type";--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('EVALUATE_SUBMISSION', 'RERUN_EXECUTION', 'VALIDATE_RUBRIC', 'REEVALUATE_ASSIGNMENT_VERSION', 'DELETE_SUBMISSION');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "type" SET DATA TYPE "public"."job_type" USING "type"::"public"."job_type";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;