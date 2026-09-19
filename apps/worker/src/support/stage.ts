/**
 * ENV_PREP 단계의 앞부분: 지원 여부 판정과 기록 (TICKET.md T-203).
 *
 * - ENV_PREP 기록을 RUNNING으로 만들고(이미 RUNNING이면 유지) 판정 결과(`SupportReport`)를 `detail`에 남긴다.
 * - 지원하지 않으면 ENV_PREP를 UNSUPPORTED로 닫고, 뒤 단계를 모두 SKIPPED로 기록하며, 제출 상태를
 *   UNSUPPORTED로 바꾼다. 아무것도 실행하지 않는다.
 * - 지원하면 ENV_PREP는 RUNNING인 채로 돌려준다. 러너 `prepare`(T-204)가 끝난 뒤 오케스트레이터가 DONE으로 닫는다.
 *
 * 템플릿 매니페스트를 읽지 못하거나 스냅샷이 스토어에 없는 것은 제출물 탓이 아니므로 예외(ENVIRONMENT)로 던진다.
 */
import { maskSensitive } from "@ohmyti/core";
import {
  getEvaluation,
  markSubmissionUnsupported,
  skipStagesAfter,
  updateEvaluationStage,
  type Database,
  type EvaluationRow,
} from "@ohmyti/db";
import { TemplateManifestSchema, type TemplateManifest } from "@ohmyti/runner";
import type { ArtifactStore } from "@ohmyti/storage";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger";
import { checkSupport, formatSupportReasons, type SupportReport } from "./check";
import { loadSnapshotFiles } from "./snapshot-files";

export class TemplateManifestError extends Error {
  override readonly name = "TemplateManifestError";
  constructor(readonly detail: string) {
    super(`템플릿 매니페스트를 읽을 수 없습니다: ${detail}`);
  }
}

/** `<templateRoot>/<templateName>/template.json`을 읽는다. 러너 `prepare`와 같은 파일이다 */
export async function readTemplateManifest(
  templateRoot: string,
  templateName: string,
): Promise<TemplateManifest> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateName)) {
    throw new TemplateManifestError(
      `템플릿 이름 ${JSON.stringify(templateName)}이(가) 올바르지 않습니다`,
    );
  }
  const file = path.join(path.resolve(templateRoot), templateName, "template.json");
  try {
    return TemplateManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    throw new TemplateManifestError(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SupportCheckStageDeps {
  db: Database;
  store: ArtifactStore;
  /** `TEMPLATE_ROOT` */
  templateRoot: string;
  logger?: Logger | undefined;
  /** 사유 문자열 마스킹에 쓸 비밀값 */
  secrets?: readonly string[] | undefined;
  now?: (() => Date) | undefined;
}

export interface SupportCheckStageInput {
  evaluationId: string;
  submissionId: string;
  snapshotRef: string;
  templateName: string;
}

export interface SupportCheckStageResult {
  report: SupportReport;
  evaluation: EvaluationRow;
}

export const ENV_PREP_UNSUPPORTED_SKIP_REASON =
  "ENV_PREP 단계에서 지원하지 않는 제출로 판정되어 건너뜀";

export async function runSupportCheckStage(
  input: SupportCheckStageInput,
  deps: SupportCheckStageDeps,
): Promise<SupportCheckStageResult> {
  const secrets = deps.secrets ?? [];
  const now = deps.now ?? (() => new Date());
  const existing = await getEvaluation(deps.db, input.evaluationId);
  if (!existing) throw new Error(`평가를 찾을 수 없습니다: ${input.evaluationId}`);

  const template = await readTemplateManifest(deps.templateRoot, input.templateName);
  const files = await loadSnapshotFiles(deps.store, input.snapshotRef);
  const raw = await checkSupport(files, template);
  const report: SupportReport = {
    ...raw,
    reasons: raw.reasons.map((r) => ({ ...r, detail: maskSensitive(r.detail, secrets) })),
  };

  if (report.supported) {
    const evaluation = await updateEvaluationStage(deps.db, input.evaluationId, "ENV_PREP", {
      state: "RUNNING",
      detail: report,
      now: now(),
    });
    deps.logger?.info(
      {
        framework: report.framework,
        language: report.language,
        testFramework: report.testFramework,
      },
      "지원하는 제출입니다",
    );
    return { report, evaluation };
  }

  const reason = formatSupportReasons(report.reasons);
  // RUNNING을 거쳐 UNSUPPORTED로 닫는다 (부록 B: PENDING → RUNNING → UNSUPPORTED)
  await updateEvaluationStage(deps.db, input.evaluationId, "ENV_PREP", {
    state: "RUNNING",
    now: now(),
  });
  await updateEvaluationStage(deps.db, input.evaluationId, "ENV_PREP", {
    state: "UNSUPPORTED",
    reason,
    detail: report,
    now: now(),
  });
  const evaluation = await skipStagesAfter(
    deps.db,
    input.evaluationId,
    "ENV_PREP",
    ENV_PREP_UNSUPPORTED_SKIP_REASON,
    now(),
  );
  await markSubmissionUnsupported(deps.db, input.submissionId, reason);
  deps.logger?.warn({ reasons: report.reasons }, "지원하지 않는 제출입니다");
  return { report, evaluation };
}
