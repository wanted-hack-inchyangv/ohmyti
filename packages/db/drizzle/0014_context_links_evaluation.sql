ALTER TABLE "context_links" ADD COLUMN "evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "context_links" ADD COLUMN "claim_source" text DEFAULT 'RESUME' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_links" ADD CONSTRAINT "context_links_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_links" ADD CONSTRAINT "context_links_claim_source_known" CHECK ("context_links"."claim_source" in ('RESUME', 'SYSTEM'));--> statement-breakpoint
ALTER TABLE "context_links" ADD CONSTRAINT "context_links_status_known" CHECK ("context_links"."status"::text in ('EVIDENCE_FOUND', 'NEEDS_CHECK', 'NO_DATA'));