/**
 * 맥락 연결·인터뷰 키트 단계 격리 검사 (TICKET.md T-503, T-702 인수 기준).
 *
 * TypeScript AST로 식별자만 검사한다. 주석과 문자열은 보지 않는다.
 *
 * 점수 규칙 (CONTEXT_LINK 단계 파일, INTERVIEW_KIT LLM 입력 생성 파일)
 * 1. 이름에 score·points·earned가 들어간 식별자를 쓰지 않는다.
 * 2. 판정 행 전체나 평가 행을 돌려주는 함수(`listCriterionResults`, `getEvaluation` 등)와 `evaluations` 테이블을 쓰지 않는다.
 * 3. `criterionResults.<열>`은 기준 ID·판정·관측·평가 ID 네 열만 쓴다.
 * 4. `from(criterionResults)` 앞의 `select()`는 열을 명시해야 한다(인자 없는 select는 모든 열을 읽는다).
 *
 * 이력서 규칙 (INTERVIEW_KIT 단계 파일 전체, T-702)
 * 5. 이력서 본문·JD·GitHub 소스(`submission_context`)를 읽는 식별자(`getSubmissionContext`, `resumeText`, `githubSources` 등)와
 *    맥락 연결의 이력서 인용(`claim`)을 쓰지 않는다. LLM 입력 생성 파일은 맥락 연결 자체(`listContextLinks`, 이력서 연결 질문)도 쓰지 않는다.
 *    이력서 연결 슬롯은 맥락 연결 단계의 질문을 그대로 옮기며 이 단계의 LLM에 넘기지 않는다 (PRD 14.2).
 *
 * 실행: `pnpm context:isolation-check` (위반이 있으면 종료 코드 1)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 검사 대상: 맥락 연결 단계를 이루는 파일 */
export const CONTEXT_STAGE_FILES = [
  "packages/context/src/context-link.ts",
  "packages/db/src/context-links.ts",
  "apps/worker/src/pipeline/context-link.ts",
] as const;

/** INTERVIEW_KIT 단계 파일: 이력서·GitHub 규칙만 적용한다 (질문 순서를 정하는 계획 입력은 잃은 배점을 읽는다) */
export const INTERVIEW_KIT_STAGE_FILES = [
  "apps/worker/src/interview-kit/facts.ts",
  "apps/worker/src/interview-kit/plan.ts",
  "apps/worker/src/interview-kit/templates.ts",
  "apps/worker/src/interview-kit/postprocess.ts",
  "apps/worker/src/interview-kit/stage.ts",
] as const;

/** INTERVIEW_KIT LLM 입력 생성 파일: 점수 규칙과 이력서 규칙(맥락 연결 포함)을 모두 적용한다 */
export const INTERVIEW_KIT_INPUT_FILES = ["apps/worker/src/interview-kit/prompt.ts"] as const;

const SCORE_NAME = /score|points|earned/i;

/** 이력서 본문·JD·GitHub 소스를 읽는 식별자 */
const RESUME_IDENTIFIERS = new Set([
  "getSubmissionContext",
  "submissionContext",
  "upsertSubmissionContext",
  "resumeText",
  "resumeTextStatus",
  "runResumeExtraction",
  "jdText",
  "githubSources",
  "GitHubSources",
  "GitHubSourcesSchema",
  "runGitHubSourcesCollection",
  "buildContextLinkInput",
  "claim",
]);

/** LLM 입력 생성 파일에서 추가로 금지하는 맥락 연결 식별자 */
const CONTEXT_LINK_IDENTIFIERS = new Set([
  "listContextLinks",
  "contextLinks",
  "toContextLink",
  "followUpQuestion",
  "resumeBridge",
]);

const BANNED_IDENTIFIERS = new Set([
  "evaluations",
  "listCriterionResults",
  "lockCriterionResults",
  "toCriterionResult",
  "getEvaluation",
  "findOpenEvaluation",
  "findFinishedEvaluationForVersion",
  "aggregateScore",
  "persistEvaluationResults",
]);

const ALLOWED_CRITERION_COLUMNS = new Set([
  "criterionId",
  "verdict",
  "observation",
  "evaluationId",
]);

export interface IsolationViolation {
  file: string;
  line: number;
  rule:
    | "SCORE_IDENTIFIER"
    | "BANNED_IDENTIFIER"
    | "CRITERION_COLUMN"
    | "SELECT_ALL"
    | "RESUME_IDENTIFIER";
  text: string;
}

export interface IsolationRules {
  /** 점수 규칙 1~4 (기본 true) */
  score?: boolean;
  /** 이력서 규칙 5 (기본 false) */
  resume?: boolean;
  /** 규칙 5에 맥락 연결 식별자까지 포함 (기본 false) */
  contextLinks?: boolean;
}

export function findIsolationViolations(
  source: string,
  file: string,
  rules: IsolationRules = {},
): IsolationViolation[] {
  const score = rules.score ?? true;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: IsolationViolation[] = [];
  const report = (node: ts.Node, rule: IsolationViolation["rule"]) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ file, line: line + 1, rule, text: node.getText(sf).slice(0, 120) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = node.text;
      if (score && SCORE_NAME.test(name)) report(node, "SCORE_IDENTIFIER");
      else if (score && BANNED_IDENTIFIERS.has(name)) report(node, "BANNED_IDENTIFIER");
      else if (
        rules.resume &&
        (RESUME_IDENTIFIERS.has(name) || (rules.contextLinks && CONTEXT_LINK_IDENTIFIERS.has(name)))
      ) {
        report(node, "RESUME_IDENTIFIER");
      }
    }
    if (
      score &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "criterionResults" &&
      !ALLOWED_CRITERION_COLUMNS.has(node.name.text)
    ) {
      report(node, "CRITERION_COLUMN");
    }
    if (
      score &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.some((a) => ts.isIdentifier(a) && a.text === "criterionResults")
    ) {
      const selectCall = node.expression.expression;
      const explicit =
        ts.isCallExpression(selectCall) &&
        ts.isPropertyAccessExpression(selectCall.expression) &&
        selectCall.expression.name.text === "select" &&
        selectCall.arguments.length > 0;
      if (!explicit) report(node, "SELECT_ALL");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

export async function checkContextIsolation(
  files: readonly string[] = CONTEXT_STAGE_FILES,
  rules: IsolationRules = {},
): Promise<IsolationViolation[]> {
  const all: IsolationViolation[] = [];
  for (const file of files) {
    const source = await readFile(path.join(REPO_ROOT, file), "utf8");
    all.push(...findIsolationViolations(source, file, rules));
  }
  return all;
}

/** INTERVIEW_KIT 단계 검사 (T-702): 단계 파일은 이력서 규칙, LLM 입력 생성 파일은 점수·이력서·맥락 연결 규칙 */
export async function checkInterviewKitIsolation(): Promise<IsolationViolation[]> {
  return [
    ...(await checkContextIsolation(INTERVIEW_KIT_STAGE_FILES, { score: false, resume: true })),
    ...(await checkContextIsolation(INTERVIEW_KIT_INPUT_FILES, {
      score: true,
      resume: true,
      contextLinks: true,
    })),
  ];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = [...(await checkContextIsolation()), ...(await checkInterviewKitIsolation())];
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule} ${v.text}`);
    console.error(`맥락 연결·인터뷰 키트 격리 검사 실패: 위반 ${violations.length}건`);
    process.exit(1);
  }
  const fileCount =
    CONTEXT_STAGE_FILES.length +
    INTERVIEW_KIT_STAGE_FILES.length +
    INTERVIEW_KIT_INPUT_FILES.length;
  console.log(`맥락 연결·인터뷰 키트 격리 검사 OK (${fileCount}개 파일)`);
}
