-- T-407: LLM 근거(REVIEW_WRITE)의 출처·제안 내용 (core EvidenceDetail). 그 밖의 근거는 null이다.
ALTER TABLE "evidences" ADD COLUMN "detail" jsonb;