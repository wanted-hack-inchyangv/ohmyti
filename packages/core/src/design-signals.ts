/**
 * 설계 평가용 결정적 코드 신호 (TICKET.md T-605). 워커가 `@ohmyti/analysis`로 제출물의 AST를 읽어(실행하지 않는다)
 * `evaluations/<id>/analysis/design-signals.json`에 저장하고, 리뷰 작성 프롬프트(REVIEW_WRITE)와 워크벤치 사람 검토 기준의
 * 근거 패널이 읽는다. web은 analysis 패키지에 의존할 수 없으므로(G-05) 형태만 여기에 둔다.
 *
 * - 값은 센 사실이다("`any` 12곳"). 좋고 나쁨의 해석과 임계값은 두지 않는다(LLM 초안과 사람의 몫, PRD 13장).
 * - 판정·점수·판정 digest에 쓰지 않는다. Evidence 행을 만들지 않고 아티팩트로만 남긴다 (G-01).
 * - 위치 목록은 `MAX_SIGNAL_LOCATIONS`개까지만 남기고 개수(`count`)는 전체를 센다.
 * - 분석 실패(파일 한도·문법 오류로 인한 예외·시간 초과)는 단계 실패가 아니라 `status: "unavailable"` 결과다.
 */
import { z } from "zod";
import { NonNegativeIntSchema, SourceLocationSchema, type SourceLocation } from "./common";

export const DESIGN_SIGNALS_ANALYZER_VERSION = "1";
/** 신호 하나에 남기는 위치 수 상한 */
export const MAX_SIGNAL_LOCATIONS = 20;
/** 남기는 중복 블록 묶음 수 상한 */
export const MAX_DUPLICATE_GROUPS = 10;

/** 개수와 위치 (위치는 앞에서부터 상한까지) */
export const LocatedCountSchema = z.strictObject({
  count: NonNegativeIntSchema,
  locations: z.array(SourceLocationSchema).max(MAX_SIGNAL_LOCATIONS),
});
export type LocatedCount = z.infer<typeof LocatedCountSchema>;

export const DuplicateBlockGroupSchema = z.strictObject({
  /** 블록 하나의 연속 문장 수 */
  statements: z.int().min(3),
  /** 같은 모양(식별자 이름·리터럴 값만 다른)의 블록 위치. 2곳 이상 */
  locations: z.array(SourceLocationSchema).min(2).max(MAX_SIGNAL_LOCATIONS),
});
export type DuplicateBlockGroup = z.infer<typeof DuplicateBlockGroupSchema>;

export const DesignSignalsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    analyzerVersion: z.string().min(1),
    /** 테스트 파일을 뺀 소스 파일 수 */
    sourceFiles: NonNegativeIntSchema,
    /** 테스트 파일 수 (`test/`·`tests/`·`__tests__/`·`spec/` 아래이거나 `.test.`·`.spec.` 파일) */
    testFiles: NonNegativeIntSchema,
    /** 가장 긴 소스 파일 (테스트 제외). 소스 파일이 없으면 null */
    maxFileLines: z
      .strictObject({ lines: z.int().min(1), location: SourceLocationSchema })
      .nullable(),
    /** 가장 긴 함수 (테스트 제외). 함수가 없으면 null. `name`은 제출물의 식별자라 비신뢰 텍스트다 */
    maxFunctionLines: z
      .strictObject({
        lines: z.int().min(1),
        name: z.string().min(1).max(120),
        location: SourceLocationSchema,
      })
      .nullable(),
    /** 테스트를 뺀 소스의 명시적 `any` 타입 (`as any` 포함). `asAny`는 그중 `as any`·`<any>` 단언 수 */
    explicitAny: LocatedCountSchema.extend({ asAny: NonNegativeIntSchema }),
    /** 루트 `tsconfig.json`의 `compilerOptions.strict`. 파일이 없으면 path null. `extends`만 있어 알 수 없으면 strict null */
    tsconfig: z.strictObject({
      path: z.string().min(1).nullable(),
      strict: z.boolean().nullable(),
    }),
    /** 정규화(식별자 이름·리터럴 값 무시)한 연속 문장 블록 중 같은 모양이 2곳 이상인 것 (테스트 제외) */
    duplicateBlocks: z.strictObject({
      count: NonNegativeIntSchema,
      groups: z.array(DuplicateBlockGroupSchema).max(MAX_DUPLICATE_GROUPS),
    }),
    /** 플래그(식별자·속성 접근, `!` 포함)를 조건으로 하는 `while`·`do` 안의 `await` (테스트 제외) */
    busyWaits: LocatedCountSchema,
    /** 테스트를 뺀 소스의 `console.log` 호출 */
    consoleLogs: LocatedCountSchema,
    /**
     * 제출 테스트의 `expect(...)` 단언 중 약한 단언: `toBeTruthy`·`toBeFalsy`·`toBeDefined`, `.not.toBeNull`·`.not.toBeUndefined`,
     * HTTP 상태 범위(100~599)의 숫자와 비교하는 `toBeLessThan`류. `total`은 `expect(...)` 단언 전체 수
     */
    weakAssertions: LocatedCountSchema.extend({ total: NonNegativeIntSchema }),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    analyzerVersion: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type DesignSignals = z.infer<typeof DesignSignalsSchema>;
export type DesignSignalsOk = Extract<DesignSignals, { status: "ok" }>;

/** 약한 단언 비율 (백분율, 소수 첫째 자리 반올림). 단언이 없으면 null */
export function weakAssertionPercent(weak: { count: number; total: number }): number | null {
  if (weak.total === 0) return null;
  return Math.round((weak.count / weak.total) * 1000) / 10;
}

/** 화면·프롬프트가 함께 쓰는 신호 한 줄. `value`는 센 사실만 담는다 */
export interface DesignSignalItem {
  id:
    | "files"
    | "max-file"
    | "max-function"
    | "explicit-any"
    | "tsconfig-strict"
    | "duplicate-blocks"
    | "busy-waits"
    | "console-logs"
    | "weak-assertions";
  label: string;
  value: string;
  /** 신호가 가리키는 코드 위치 (중복 블록은 묶음 순서대로 펼친다). 상한까지만 있다 */
  locations: SourceLocation[];
  /** 위치를 센 신호의 전체 개수 (`locations`보다 많을 수 있다). 위치를 세지 않는 신호는 null */
  count: number | null;
  /** 중복 블록 묶음 (id `duplicate-blocks`만) */
  groups?: DuplicateBlockGroup[] | undefined;
}

function tsconfigValue(tsconfig: DesignSignalsOk["tsconfig"]): string {
  if (tsconfig.path === null) return "tsconfig.json 없음";
  if (tsconfig.strict === null) return "확인 불가 (extends로 상속하거나 파싱하지 못함)";
  return tsconfig.strict ? "켜짐" : "꺼짐";
}

/** 신호를 표시 순서대로 펼친다 */
export function designSignalItems(signals: DesignSignalsOk): DesignSignalItem[] {
  const weakPercent = weakAssertionPercent(signals.weakAssertions);
  return [
    {
      id: "files",
      label: "소스 파일",
      value: `${signals.sourceFiles}개 (테스트 파일 ${signals.testFiles}개 별도)`,
      locations: [],
      count: null,
    },
    {
      id: "max-file",
      label: "가장 긴 파일",
      value: signals.maxFileLines
        ? `${signals.maxFileLines.location.path} · ${signals.maxFileLines.lines}줄`
        : "없음",
      locations: signals.maxFileLines ? [signals.maxFileLines.location] : [],
      count: null,
    },
    {
      id: "max-function",
      label: "가장 긴 함수",
      value: signals.maxFunctionLines
        ? `${signals.maxFunctionLines.name} · ${signals.maxFunctionLines.lines}줄`
        : "없음",
      locations: signals.maxFunctionLines ? [signals.maxFunctionLines.location] : [],
      count: null,
    },
    {
      id: "explicit-any",
      label: "명시적 any",
      value: `${signals.explicitAny.count}곳 (as any ${signals.explicitAny.asAny}곳)`,
      locations: signals.explicitAny.locations,
      count: signals.explicitAny.count,
    },
    {
      id: "tsconfig-strict",
      label: "tsconfig strict",
      value: tsconfigValue(signals.tsconfig),
      locations: [],
      count: null,
    },
    {
      id: "duplicate-blocks",
      label: "같은 모양의 연속 문장 블록",
      value: `${signals.duplicateBlocks.count}건 (식별자 이름·리터럴 값만 다른 3문장 이상)`,
      locations: signals.duplicateBlocks.groups.flatMap((g) => g.locations),
      count: null,
      groups: signals.duplicateBlocks.groups,
    },
    {
      id: "busy-waits",
      label: "바쁜 대기",
      value: `${signals.busyWaits.count}곳 (플래그 조건 반복문 안의 await)`,
      locations: signals.busyWaits.locations,
      count: signals.busyWaits.count,
    },
    {
      id: "console-logs",
      label: "console.log",
      value: `${signals.consoleLogs.count}곳 (테스트 제외)`,
      locations: signals.consoleLogs.locations,
      count: signals.consoleLogs.count,
    },
    {
      id: "weak-assertions",
      label: "제출 테스트의 약한 단언",
      value:
        weakPercent === null
          ? "expect 단언 0개"
          : `expect 단언 ${signals.weakAssertions.total}개 중 ${signals.weakAssertions.count}개 (${weakPercent}%, toBeTruthy·toBeDefined·상태 코드 범위 비교)`,
      locations: signals.weakAssertions.locations,
      count: signals.weakAssertions.count,
    },
  ];
}
