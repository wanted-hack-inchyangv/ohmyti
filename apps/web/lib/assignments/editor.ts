/**
 * 과제 설정 화면(T-406)의 편집 모델. 폼 값(문자열) ↔ `Rubric`·`ExecutionContract` 변환과 검증을 순수 함수로 둔다.
 * 클라이언트 편집기는 입력할 때마다 이 함수로 오류를 보여 주고, 서버 액션은 같은 함수로 다시 검사한 뒤 저장한다.
 *
 * 표에서 편집하는 것은 기준 행(ID·영역·제목·배점·방법·판정 조건·PARTIAL 허용·그룹)이고, 그룹·PARTIAL 하위 기준·
 * 독립 감점 사유·정적 검사는 "추가 규칙(JSON)" 한 칸에서 편집한다.
 */
import {
  ExecutionContractSchema,
  MethodSchema,
  RubricAreaSchema,
  RubricSchema,
  StaticCheckSchema,
  IndependentReasonSchema,
  PartialRuleSchema,
  RubricGroupSchema,
  validateRubric,
  type ExecutionContract,
  type Method,
  type Rubric,
  type RubricArea,
} from "@ohmyti/core";
import { z } from "zod";

export interface CriterionRow {
  id: string;
  area: RubricArea;
  title: string;
  /** 입력 중인 문자열. 정수가 아니면 오류로 보여 준다 */
  maxPoints: string;
  method: Method;
  condition: string;
  allowPartial: boolean;
  /** 빈 문자열이면 그룹 없음 */
  groupId: string;
}

export interface ContractForm {
  startCommand: string;
  portEnv: string;
  healthPath: string;
  healthTimeoutMs: string;
  /** 빈 문자열이면 리셋 없음 */
  resetPath: string;
  templateName: string;
  nodeVersion: string;
}

/** 화면에 보여 줄 오류 하나. `validateRubric()` 오류와 형식 오류를 같은 모양으로 다룬다 */
export interface EditorIssue {
  code: string;
  message: string;
  ref?: string | undefined;
}

export const AREA_LABEL: Record<RubricArea, string> = {
  REQUIRED_FEATURES: "요구 기능",
  EDGE_AND_FAILURE: "경계·실패",
  TEST_EFFECTIVENESS: "테스트 실효성",
  DESIGN: "설계·변경 용이성",
  REPRODUCIBILITY_AND_DOCS: "실행 재현성·문서",
};

export const METHOD_LABEL: Record<Method, string> = {
  EXECUTION: "실행",
  STATIC: "정적",
  MUTATION: "결함 주입",
  HUMAN_REVIEW: "사람 검토",
};

export const AREAS = RubricAreaSchema.options;
export const METHODS = MethodSchema.options;

/** 추가 규칙 JSON의 모양 */
export const RubricExtrasSchema = z.strictObject({
  groups: z.array(RubricGroupSchema),
  partialRules: z.array(PartialRuleSchema),
  independentReasons: z.array(IndependentReasonSchema),
  /** 기준 ID → 정적 검사 (STATIC 기준만) */
  staticChecks: z.record(z.string().min(1), z.array(StaticCheckSchema).min(1)),
});
export type RubricExtras = z.infer<typeof RubricExtrasSchema>;

export const EMPTY_EXTRAS: RubricExtras = {
  groups: [],
  partialRules: [],
  independentReasons: [],
  staticChecks: {},
};

export function rubricToRows(rubric: Rubric): CriterionRow[] {
  return rubric.criteria.map((c) => ({
    id: c.id,
    area: c.area,
    title: c.title,
    maxPoints: String(c.maxPoints),
    method: c.method,
    condition: c.condition,
    allowPartial: c.allowPartial,
    groupId: c.groupId ?? "",
  }));
}

export function rubricToExtras(rubric: Rubric): RubricExtras {
  const staticChecks: RubricExtras["staticChecks"] = {};
  for (const c of rubric.criteria) if (c.staticChecks) staticChecks[c.id] = c.staticChecks;
  return {
    groups: rubric.groups,
    partialRules: rubric.partialRules,
    independentReasons: rubric.independentReasons,
    staticChecks,
  };
}

export function formatExtras(extras: RubricExtras): string {
  return JSON.stringify(extras, null, 2);
}

export function emptyRow(index: number): CriterionRow {
  return {
    id: `R-${String(index + 1).padStart(2, "0")}`,
    area: "REQUIRED_FEATURES",
    title: "",
    maxPoints: "0",
    method: "EXECUTION",
    condition: "",
    allowPartial: false,
    groupId: "",
  };
}

/** 배점 합계. 정수가 아닌 칸은 0으로 센다 (합계 표시용) */
export function totalPoints(rows: readonly CriterionRow[]): number {
  return rows.reduce((sum, row) => {
    const n = Number(row.maxPoints.trim());
    return Number.isSafeInteger(n) && n >= 0 ? sum + n : sum;
  }, 0);
}

export type EditorRubricResult =
  { ok: true; rubric: Rubric; issues: EditorIssue[] } | { ok: false; issues: EditorIssue[] };

/**
 * 표와 추가 규칙으로 `Rubric`을 만들고 `validateRubric()`까지 돌린다.
 * 형식 오류(숫자·JSON·필수 칸)가 있으면 `ok: false`, 형식은 맞지만 기준 규칙을 어기면 `ok: true` + `issues`다.
 * 저장은 `issues`가 비어 있을 때만 한다.
 */
export function editorToRubric(
  rows: readonly CriterionRow[],
  extrasJson: string,
): EditorRubricResult {
  const issues: EditorIssue[] = [];
  if (rows.length === 0) {
    issues.push({ code: "NO_CRITERIA", message: "기준을 하나 이상 입력하세요" });
  }
  rows.forEach((row, index) => {
    const ref = row.id.trim() || `${index + 1}번째 행`;
    const n = Number(row.maxPoints.trim());
    if (row.maxPoints.trim() === "" || !Number.isSafeInteger(n) || n < 0) {
      issues.push({
        code: "INVALID_POINTS",
        message: `배점은 0 이상의 정수여야 합니다: ${ref}`,
        ref,
      });
    }
    if (!row.id.trim())
      issues.push({ code: "MISSING_ID", message: `기준 ID를 입력하세요: ${ref}`, ref });
    if (!row.title.trim()) {
      issues.push({ code: "MISSING_TITLE", message: `기준 제목을 입력하세요: ${ref}`, ref });
    }
    if (!row.condition.trim()) {
      issues.push({ code: "MISSING_CONDITION", message: `판정 조건을 입력하세요: ${ref}`, ref });
    }
  });

  let extras: RubricExtras = EMPTY_EXTRAS;
  if (extrasJson.trim() !== "") {
    let raw: unknown;
    try {
      raw = JSON.parse(extrasJson);
    } catch (error) {
      issues.push({
        code: "EXTRAS_JSON",
        message: `추가 규칙 JSON을 읽을 수 없습니다: ${(error as Error).message}`,
      });
    }
    if (raw !== undefined) {
      const parsed = RubricExtrasSchema.safeParse(raw);
      if (parsed.success) extras = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          issues.push({
            code: "EXTRAS_SCHEMA",
            message: `추가 규칙 ${issue.path.join(".") || "(최상위)"}: ${issue.message}`,
          });
        }
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const rowIds = new Set(rows.map((r) => r.id.trim()));
  for (const id of Object.keys(extras.staticChecks)) {
    if (!rowIds.has(id)) {
      issues.push({
        code: "STATIC_CHECK_UNKNOWN_CRITERION",
        message: `정적 검사가 존재하지 않는 기준을 참조합니다: ${id}`,
        ref: id,
      });
    }
  }

  const candidate: Rubric = {
    version: "draft",
    criteria: rows.map((row) => {
      const id = row.id.trim();
      const checks = extras.staticChecks[id];
      return {
        id,
        area: row.area,
        title: row.title.trim(),
        maxPoints: Number(row.maxPoints.trim()),
        method: row.method,
        condition: row.condition.trim(),
        allowPartial: row.allowPartial,
        ...(row.groupId.trim() ? { groupId: row.groupId.trim() } : {}),
        ...(checks ? { staticChecks: checks } : {}),
      };
    }),
    groups: extras.groups,
    partialRules: extras.partialRules,
    independentReasons: extras.independentReasons,
  };
  const parsed = RubricSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "RUBRIC_SCHEMA",
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const validation = validateRubric(parsed.data);
  if (!validation.ok) issues.push(...validation.errors);
  return { ok: true, rubric: parsed.data, issues };
}

export function contractToForm(contract: ExecutionContract): ContractForm {
  return {
    startCommand: contract.startCommand,
    portEnv: contract.portEnv,
    healthPath: contract.healthPath,
    healthTimeoutMs: String(contract.healthTimeoutMs),
    resetPath: contract.resetPath ?? "",
    templateName: contract.templateName,
    nodeVersion: contract.nodeVersion,
  };
}

export function formToContract(
  form: ContractForm,
): { ok: true; contract: ExecutionContract } | { ok: false; issues: EditorIssue[] } {
  const timeout = Number(form.healthTimeoutMs.trim());
  const parsed = ExecutionContractSchema.safeParse({
    startCommand: form.startCommand.trim(),
    portEnv: form.portEnv.trim(),
    healthPath: form.healthPath.trim(),
    healthTimeoutMs: Number.isFinite(timeout) ? timeout : Number.NaN,
    ...(form.resetPath.trim() ? { resetPath: form.resetPath.trim() } : {}),
    templateName: form.templateName.trim(),
    nodeVersion: form.nodeVersion.trim(),
  });
  if (parsed.success) return { ok: true, contract: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      code: "CONTRACT_INVALID",
      message: `실행 계약 ${CONTRACT_FIELD_LABEL[i.path[0] as keyof ContractForm] ?? i.path.join(".")}: ${i.message}`,
    })),
  };
}

export const CONTRACT_FIELD_LABEL: Record<keyof ContractForm, string> = {
  startCommand: "시작 명령",
  portEnv: "포트 환경변수",
  healthPath: "헬스 경로",
  healthTimeoutMs: "헬스 대기(ms)",
  resetPath: "리셋 경로",
  templateName: "승인 템플릿",
  nodeVersion: "Node 버전",
};

/** 새 과제의 기본 실행 계약 (승인 템플릿은 하나뿐이다, T-102) */
export const DEFAULT_CONTRACT_FORM: ContractForm = {
  startCommand: "npm start",
  portEnv: "PORT",
  healthPath: "/health",
  healthTimeoutMs: "10000",
  resetPath: "/admin/reset",
  templateName: "order-api-ts",
  nodeVersion: "22",
};

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "paragraph"; text: string };

/**
 * 명세 미리보기용 최소 마크다운 해석 (제목·목록·코드 블록·문단). HTML을 만들지 않고 블록 목록만 돌려주므로
 * 화면은 React가 텍스트로 이스케이프해 그린다.
 */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", items: list });
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        code.push(lines[i]!);
        i += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list = list ?? [];
      list.push(item[1]!.trim());
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
