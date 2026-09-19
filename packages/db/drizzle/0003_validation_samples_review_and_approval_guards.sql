ALTER TABLE "validation_samples" ADD COLUMN "human_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "validation_samples" ADD COLUMN "human_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "validation_samples" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- T-201: 승인된 버전은 불변이다. APPROVED·RETIRED 행은 status(APPROVED → RETIRED)·retired_at·updated_at만 바뀔 수 있고
-- rubric·rubric_version·execution_contract·spec·harness_version·validation_result·승인 정보는 바꿀 수 없다.
-- 수정은 새 버전 생성으로만 한다.
CREATE OR REPLACE FUNCTION public.assignment_versions_reject_approved_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status NOT IN ('APPROVED', 'RETIRED') THEN
    RETURN NEW;
  END IF;
  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.spec_ref IS DISTINCT FROM OLD.spec_ref
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.rubric IS DISTINCT FROM OLD.rubric
     OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
     OR NEW.execution_contract IS DISTINCT FROM OLD.execution_contract
     OR NEW.harness_version IS DISTINCT FROM OLD.harness_version
     OR NEW.validation_result IS DISTINCT FROM OLD.validation_result
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'assignment_versions % is immutable once % (T-201): create a new version instead', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'assignment_versions_immutable_when_approved';
  END IF;
  IF (OLD.status = 'APPROVED' AND NEW.status NOT IN ('APPROVED', 'RETIRED'))
     OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') THEN
    RAISE EXCEPTION 'assignment_versions %: % -> % transition is not allowed (T-201)', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'assignment_versions_immutable_when_approved';
  END IF;
  IF NEW.status = 'RETIRED' AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'assignment_versions %: retired_at is required when RETIRED (T-201)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_versions_immutable_when_approved';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER assignment_versions_immutable_when_approved
BEFORE UPDATE ON public.assignment_versions
FOR EACH ROW EXECUTE FUNCTION public.assignment_versions_reject_approved_mutation();--> statement-breakpoint
-- T-201: 제출은 APPROVED 버전에만 만들 수 있다. 서버 액션 검사와 별도로 DB가 강제한다.
CREATE OR REPLACE FUNCTION public.submissions_require_approved_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT status::text INTO version_status
    FROM public.assignment_versions
   WHERE id = NEW.assignment_version_id;
  IF version_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'RUBRIC_NOT_APPROVED: assignment version % has status % (T-201)', NEW.assignment_version_id, COALESCE(version_status, 'MISSING')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'submissions_require_approved_version';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER submissions_require_approved_version
BEFORE INSERT OR UPDATE OF assignment_version_id ON public.submissions
FOR EACH ROW EXECUTE FUNCTION public.submissions_require_approved_version();
