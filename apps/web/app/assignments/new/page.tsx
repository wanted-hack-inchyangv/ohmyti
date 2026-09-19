import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { DEFAULT_CONTRACT_FORM, EMPTY_EXTRAS, formatExtras } from "@/lib/assignments/editor";
import { readNewAssignmentOptions } from "@/lib/assignments/service";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { AssignmentEditor } from "../assignment-editor";
import { BackLink } from "../setup-views";

export const metadata: Metadata = { title: "새 과제 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

/**
 * PRD 6장 ① 과제 설정 (T-406): 명세·실행 계약을 입력하고, AI 초안으로 요구사항·배점 표를 채운 뒤 사람이 고쳐 저장한다.
 * 저장하면 DRAFT 버전이 생기고, 검증·승인은 버전 화면에서 한다.
 */
export default async function NewAssignmentPage() {
  let harnessVersions: string[];
  try {
    ({ harnessVersions } = await readNewAssignmentOptions({ db: getDb().db }));
  } catch {
    // 연결 문자열 등 비밀값이 섞일 수 있으므로 오류 본문은 화면에 내지 않는다
    return (
      <PageContainer width="wide">
        <PageHeader title="새 과제" />
        <Notice tone="error">
          과제 설정을 준비하지 못했습니다. 데이터베이스 연결을 확인하세요 (
          <code className="font-mono">/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  return (
    <PageContainer width="wide">
      <div className="flex flex-col gap-4">
        <BackLink />
        <PageHeader
          title="새 과제"
          description="명세와 실행 계약을 입력하고 요구사항·배점을 정합니다. AI 초안은 제안일 뿐이며, 저장한 기준은 검증 샘플로 채점기를 검증하고 승인한 뒤에만 지원자 채점에 쓰입니다."
        />
      </div>
      <AssignmentEditor
        mode="new"
        harnessVersions={harnessVersions}
        initial={{
          name: "",
          description: "",
          title: "v1",
          specMarkdown: "",
          contract: DEFAULT_CONTRACT_FORM,
          rows: [],
          extrasJson: formatExtras(EMPTY_EXTRAS),
          harnessVersion: harnessVersions[0] ?? "",
        }}
      />
    </PageContainer>
  );
}
