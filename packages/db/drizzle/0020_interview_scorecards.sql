CREATE TABLE "interview_scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"interviewer" text NOT NULL,
	"competencies" jsonb NOT NULL,
	"question_notes" jsonb NOT NULL,
	"final_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_scorecards_interviewer_not_blank" CHECK (btrim("interview_scorecards"."interviewer") <> '')
);
--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_scorecards_evaluation_idx" ON "interview_scorecards" USING btree ("evaluation_id","created_at");--> statement-breakpoint
-- T-707: 스코어카드 수정은 새 행으로 남긴다(이력 보존). UPDATE를 항상 거부한다.
-- DELETE는 제출 삭제 cascade(T-506)가 쓰므로 막지 않는다.
CREATE OR REPLACE FUNCTION public.interview_scorecards_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'interview_scorecards is append-only: UPDATE is not allowed (T-707)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER interview_scorecards_append_only
BEFORE UPDATE ON public.interview_scorecards
FOR EACH ROW EXECUTE FUNCTION public.interview_scorecards_reject_update();
