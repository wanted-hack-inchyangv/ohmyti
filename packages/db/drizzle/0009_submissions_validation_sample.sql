-- T-405: 채점기 사전 검증은 VALIDATING 버전의 검증 샘플을 is_sample 제출로 채점한다. 검증 제출은 샘플을 가리키며 항상 is_sample이다.
ALTER TABLE "submissions" ADD COLUMN "validation_sample_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_validation_sample_id_validation_samples_id_fk" FOREIGN KEY ("validation_sample_id") REFERENCES "public"."validation_samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submissions_validation_sample_idx" ON "submissions" USING btree ("validation_sample_id","created_at");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_validation_run_is_sample" CHECK ("submissions"."validation_sample_id" IS NULL OR "submissions"."is_sample");--> statement-breakpoint
-- T-405: 제출은 APPROVED 버전에만 만들 수 있다. 예외는 채점기 사전 검증 제출(validation_sample_id가 있음)로,
-- 샘플이 속한 VALIDATING 버전에만 만들 수 있다.
CREATE OR REPLACE FUNCTION public.submissions_require_approved_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_status text;
  sample_version uuid;
BEGIN
  SELECT status::text INTO version_status
    FROM public.assignment_versions
   WHERE id = NEW.assignment_version_id;
  IF NEW.validation_sample_id IS NOT NULL THEN
    SELECT assignment_version_id INTO sample_version
      FROM public.validation_samples
     WHERE id = NEW.validation_sample_id;
    IF sample_version IS DISTINCT FROM NEW.assignment_version_id THEN
      RAISE EXCEPTION 'VALIDATION_SAMPLE_MISMATCH: validation sample % does not belong to assignment version % (T-405)', NEW.validation_sample_id, NEW.assignment_version_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'submissions_require_approved_version';
    END IF;
    IF version_status IS DISTINCT FROM 'VALIDATING' THEN
      RAISE EXCEPTION 'RUBRIC_NOT_VALIDATING: validation runs require a VALIDATING assignment version, % has status % (T-405)', NEW.assignment_version_id, COALESCE(version_status, 'MISSING')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'submissions_require_approved_version';
    END IF;
    RETURN NEW;
  END IF;
  IF version_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'RUBRIC_NOT_APPROVED: assignment version % has status % (T-201)', NEW.assignment_version_id, COALESCE(version_status, 'MISSING')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'submissions_require_approved_version';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_require_approved_version ON public.submissions;--> statement-breakpoint
CREATE TRIGGER submissions_require_approved_version
BEFORE INSERT OR UPDATE OF assignment_version_id, validation_sample_id ON public.submissions
FOR EACH ROW EXECUTE FUNCTION public.submissions_require_approved_version();
