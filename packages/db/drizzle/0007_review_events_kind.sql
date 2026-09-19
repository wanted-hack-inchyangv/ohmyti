-- T-306: 검토 액션 종류. 이전 행(있다면)은 점수 수정 기록이므로 OVERRIDE로 채우고 기본값은 바로 없앤다
ALTER TABLE "review_events" ADD COLUMN "kind" text NOT NULL DEFAULT 'OVERRIDE';--> statement-breakpoint
ALTER TABLE "review_events" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_kind_check" CHECK ("review_events"."kind" IN ('CONFIRM', 'OVERRIDE', 'DISPUTE', 'APPROVE_DESIGN'));--> statement-breakpoint
-- 검토 이력은 쌓이기만 한다 (PRD 9장: 원래 값·수정 값·이유·검토자를 함께 보존). UPDATE는 항상 거부하고,
-- DELETE는 평가 행 삭제의 cascade(외래 키 트리거 안, pg_trigger_depth() > 0)에서만 허용한다.
CREATE OR REPLACE FUNCTION public.review_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'review_events is append-only: % is not allowed (T-306)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER review_events_append_only
BEFORE UPDATE OR DELETE ON public.review_events
FOR EACH ROW EXECUTE FUNCTION public.review_events_reject_mutation();
