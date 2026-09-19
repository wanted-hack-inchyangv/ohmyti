import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildStageViews } from "@/lib/submissions/service";
import { StageList } from "./stage-list";

describe("StageList", () => {
  it("stage_log에서 만든 6단계를 세로로 그리고 진행률 바·퍼센트가 없다", () => {
    const html = renderToStaticMarkup(
      <StageList
        stages={buildStageViews([
          {
            stage: "REPO_CHECK",
            state: "DONE",
            startedAt: "2026-09-18T00:00:00.000Z",
            finishedAt: "2026-09-18T00:00:02.000Z",
            detail: { submissionSha: "0123456789abcdef0123456789abcdef01234567", fileCount: 3 },
          },
          { stage: "ENV_PREP", state: "RUNNING", startedAt: "2026-09-18T00:00:02.000Z" },
        ])}
      />,
    );
    expect(html.match(/<li /g)).toHaveLength(6);
    expect(html).toContain('data-stage="REPO_CHECK" data-state="DONE"');
    expect(html).toContain('data-stage="ENV_PREP" data-state="RUNNING"');
    expect(html).toContain('data-stage="CONTEXT_LINK" data-state="PENDING"');
    expect(html).toContain("SHA 0123456789ab · 파일 3개");
    expect(html).not.toMatch(/%|progress|진행률/);
    expect(html).not.toMatch(/정확도|비용 절감/);
  });

  it("실패 단계는 실패 종류와 사유를, 미지원 단계는 사유 코드·상세를 그대로 보여 준다", () => {
    const html = renderToStaticMarkup(
      <StageList
        stages={buildStageViews([
          {
            stage: "REPO_CHECK",
            state: "FAILED",
            reason: "ENVIRONMENT: GitHub API 5xx",
            detail: { failureKind: "ENVIRONMENT" },
          },
          {
            stage: "ENV_PREP",
            state: "UNSUPPORTED",
            reason: "DISALLOWED_DEPENDENCY: fastify",
            detail: {
              reasons: [
                { code: "DISALLOWED_DEPENDENCY", detail: "fastify@5.0.0은 허용 목록에 없음" },
              ],
            },
          },
        ])}
      />,
    );
    expect(html).toContain("환경 장애");
    expect(html).toContain("ENVIRONMENT: GitHub API 5xx");
    expect(html).toContain("DISALLOWED_DEPENDENCY");
    expect(html).toContain("fastify@5.0.0은 허용 목록에 없음");
  });
});
