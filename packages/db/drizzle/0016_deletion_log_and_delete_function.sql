CREATE INDEX "deletion_log_submission_idx" ON "deletion_log" USING btree ("submission_id");--> statement-breakpoint
-- T-506: 제출 삭제 전용 함수. execution_records 불변 트리거(0001)의 삭제 통로를 이 함수 안에서만 연다.
-- 삭제 요청(submissions.deleted_at)이 기록된 제출의 평가에 속한 실행 기록만 지우고, 끝나면 통로를 다시 닫는다.
-- 이 기록을 참조하는 evidences·mutation_experiments(restrict FK)는 호출 전에 지워야 한다.
CREATE OR REPLACE FUNCTION public.delete_submission_execution_records(p_submission_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.submissions
    WHERE id = p_submission_id AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'submission % is not marked for deletion (T-506)', p_submission_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM set_config('ohmyti.allow_execution_record_delete', 'on', true);
  DELETE FROM public.execution_records
  WHERE evaluation_id IN (SELECT id FROM public.evaluations WHERE submission_id = p_submission_id);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('ohmyti.allow_execution_record_delete', 'off', true);
  RETURN deleted;
END;
$$;
