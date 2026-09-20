"use server";

/**
 * 제출·분석 화면 서버 액션 (T-206). 실제 로직은 `service.ts`에 있으며 여기서는 DB·스토어 핸들과
 * FormData 변환만 한다. 제출 코드는 어디서도 실행하지 않는다 (G-05).
 */
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { exampleResumeKey } from "./prefill";
import {
  createSubmissionWithContext,
  requestDeletion,
  retrySubmission,
  saveManualResumeText,
  type CreatedSubmission,
  type DeletionRequested,
  type ResumeTextView,
  type ResumeUpload,
  type SubmissionActionResult,
} from "./service";

function fieldOf(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

async function resumeOf(formData: FormData): Promise<ResumeUpload | null> {
  const value = formData.get("resume");
  if (!(value instanceof File) || value.size === 0 || value.name === "") return null;
  return { bytes: new Uint8Array(await value.arrayBuffer()), fileName: value.name };
}

/**
 * `예시 이력서 사용` (T-902). 폼이 보낸 **식별자**를 허용 목록의 아티팩트 키로 바꿔 읽는다. 목록에 없는 값이나
 * 경로 문자열로는 아무것도 읽지 않는다. 읽은 바이트는 업로드와 같은 `validateResume` 경로를 지난다.
 */
async function exampleResumeOf(formData: FormData): Promise<ResumeUpload | null> {
  const key = exampleResumeKey(fieldOf(formData, "exampleResumeId"));
  if (!key) return null;
  const object = await getArtifactStore().get(key);
  if (!object) return null;
  return { bytes: new Uint8Array(object.body), fileName: "example-resume.pdf" };
}

/** 폼 제출. 성공하면 새 제출 ID를 돌려주고 클라이언트가 `/submissions/<id>`로 이동한다. 실패 사유는 폼이 그대로 보여 준다 (G-09) */
export async function createSubmissionFromFormAction(
  formData: FormData,
): Promise<SubmissionActionResult<CreatedSubmission>> {
  const result = await createSubmissionWithContext(
    { db: getDb().db, store: getArtifactStore() },
    {
      assignmentVersionId: fieldOf(formData, "assignmentVersionId") ?? "",
      repoUrl: fieldOf(formData, "repoUrl") ?? "",
      commitSha: fieldOf(formData, "commitSha") ?? "",
      githubProfileUrl: fieldOf(formData, "githubProfileUrl") ?? "",
    },
    (await resumeOf(formData)) ?? (await exampleResumeOf(formData)),
  );
  return result;
}

/** 환경 장애로 실패한 제출을 같은 입력으로 다시 제출한다. 클라이언트가 새 제출 화면으로 이동한다 */
export async function retrySubmissionAction(
  submissionId: string,
): Promise<SubmissionActionResult<CreatedSubmission>> {
  return retrySubmission({ db: getDb().db, store: getArtifactStore() }, submissionId);
}

/** 텍스트를 추출하지 못한 이력서에 직접 입력한 텍스트를 저장한다 (T-501). 본문은 응답에 넣지 않는다 */
export async function saveManualResumeTextAction(
  submissionId: string,
  text: string,
): Promise<SubmissionActionResult<ResumeTextView>> {
  return saveManualResumeText({ db: getDb().db }, { submissionId, text });
}

/** 제출 삭제 요청 (T-506). 모달에서 입력한 검토자 이름을 삭제 기록에 남긴다. 실제 삭제는 워커가 한다 */
export async function requestDeletionAction(
  submissionId: string,
  reviewerName: string,
): Promise<SubmissionActionResult<DeletionRequested>> {
  return requestDeletion({ db: getDb().db }, { submissionId, reviewerName });
}
