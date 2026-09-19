-- G-03: execution_records는 불변이다. UPDATE는 항상 거부하고, DELETE는 제출 삭제 전용 경로(T-506)가
-- 같은 트랜잭션에서 `SET LOCAL ohmyti.allow_execution_record_delete = 'on'`을 설정했을 때만 허용한다.
CREATE OR REPLACE FUNCTION public.execution_records_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('ohmyti.allow_execution_record_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'execution_records is immutable: % is not allowed (G-03)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER execution_records_immutable
BEFORE UPDATE OR DELETE ON public.execution_records
FOR EACH ROW EXECUTE FUNCTION public.execution_records_reject_mutation();
