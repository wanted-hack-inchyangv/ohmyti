/**
 * 채점기 사전 검증(T-405)의 REPO_CHECK: 검증 제출은 GitHub 저장소가 아니라 `validation_samples.snapshot_ref`의 스냅샷을 채점한다.
 * 샘플 스냅샷을 제출 스냅샷 키(`submissions/<id>/snapshot.tar.gz`)로 복사하고 SHA(샘플 내용 해시)를 고정한다.
 * 같은 키에 같은 바이트를 덮어쓰므로 재시도해도 결과가 같다.
 */
import { pinSubmissionSnapshot, validationSamples, type Database } from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

export interface ValidationSampleSnapshotResult {
  submissionSha: string;
  snapshotRef: string;
  detail: Record<string, unknown>;
}

export class ValidationSampleMissingError extends Error {
  override readonly name = "ValidationSampleMissingError";
}

export async function copyValidationSampleSnapshot(
  input: { submissionId: string; validationSampleId: string },
  deps: { db: Database; store: ArtifactStore },
): Promise<ValidationSampleSnapshotResult> {
  const [sample] = await deps.db
    .select()
    .from(validationSamples)
    .where(eq(validationSamples.id, input.validationSampleId))
    .limit(1);
  if (!sample) {
    throw new ValidationSampleMissingError(
      `검증 샘플을 찾을 수 없습니다: ${input.validationSampleId}`,
    );
  }
  const object = await deps.store.get(sample.snapshotRef);
  if (!object) {
    throw new ValidationSampleMissingError(
      `검증 샘플 ${sample.name}의 스냅샷이 스토어에 없습니다: ${sample.snapshotRef}`,
    );
  }
  const snapshotRef = artifactKeys.snapshot(input.submissionId);
  await deps.store.put(snapshotRef, object.body, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });
  await pinSubmissionSnapshot(deps.db, input.submissionId, {
    submissionSha: sample.submissionSha,
    snapshotRef,
  });
  return {
    submissionSha: sample.submissionSha,
    snapshotRef,
    detail: {
      submissionSha: sample.submissionSha,
      snapshotRef,
      source: "validation_sample",
      validationSampleId: sample.id,
      sampleName: sample.name,
      sampleKind: sample.kind,
      sampleSnapshotRef: sample.snapshotRef,
      snapshotBytesSha256: createHash("sha256").update(object.body).digest("hex"),
    },
  };
}
