import { NextResponse } from "next/server";
import { CreateSubmissionRequestSchema } from "@ohmyti/core";
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import type { ReportResult } from "@/lib/reports/service";
import {
  createSubmissionWithContext,
  type CreatedSubmission,
  type SubmissionActionResult,
} from "@/lib/submissions/service";

export const dynamic = "force-dynamic";

/** 폼 서비스의 결과를 조회 API와 같은 봉투로 옮긴다. 이 라우트는 이력서를 받지 않으므로 `NOT_RETRYABLE`·`INTERNAL`은 나오지 않는다 */
export function toApiResult(
  result: SubmissionActionResult<CreatedSubmission>,
): ReportResult<CreatedSubmission> {
  if (result.ok) return result;
  switch (result.code) {
    case "INVALID_INPUT":
    case "VERSION_NOT_FOUND":
    case "RUBRIC_NOT_APPROVED":
    case "SUBMISSION_NOT_FOUND":
      return { ok: false, code: result.code, message: result.message };
    default:
      return { ok: false, code: "INVALID_INPUT", message: result.message };
  }
}

/**
 * 제출 생성 API (T-208). 2단계 게이트 스크립트(`pnpm gate:phase2`)가 배포 환경에 샘플을 제출할 때 쓴다.
 * 본문은 JSON(`CreateSubmissionRequestSchema`)이며 폼(T-206)과 같은 `createSubmissionWithContext`를 거친다.
 * 이력서는 받지 않는다. 접근 보호는 proxy(T-008)가 모든 `/api/*`에 적용한다. 제출 코드는 실행하지 않는다 (G-05).
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_INPUT", message: "요청 본문이 JSON이 아닙니다" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const parsed = CreateSubmissionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return reportResponse({
      ok: false,
      code: "INVALID_INPUT",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "입력"}: ${i.message}`)
        .join("; "),
    });
  }
  const result = await createSubmissionWithContext(
    { db: getDb().db, store: getArtifactStore() },
    {
      assignmentVersionId: parsed.data.assignmentVersionId,
      repoUrl: parsed.data.repoUrl,
      commitSha: parsed.data.commitSha ?? "",
      githubProfileUrl: parsed.data.githubProfileUrl ?? "",
    },
    null,
  );
  const api = toApiResult(result);
  if (!api.ok) return reportResponse(api);
  return NextResponse.json(api, { status: 201, headers: { "cache-control": "no-store" } });
}
