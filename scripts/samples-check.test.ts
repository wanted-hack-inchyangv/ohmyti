import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRubric, RubricSchema } from "@ohmyti/core";
import {
  EXPECTED_CONTRACT,
  ExpectedMatrixSchema,
  parseSpecInventory,
  readJson,
  runSampleCheck,
  SAMPLE_DIR,
} from "./samples-check";

const FILES = ["SPEC.md", "execution-contract.json", "rubric.v1.json", "expected-matrix.json"];
const tempDirs: string[] = [];

/** 실제 샘플 디렉터리를 임시 디렉터리로 복사하고, 필요하면 파일 하나를 변형한다. */
function copySamples(mutate?: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ohmyti-samples-"));
  tempDirs.push(dir);
  for (const file of FILES) {
    writeFileSync(path.join(dir, file), readFileSync(path.join(SAMPLE_DIR, file)));
  }
  mutate?.(dir);
  return dir;
}

function editJson(dir: string, file: string, edit: (json: Record<string, unknown>) => void): void {
  const target = path.join(dir, file);
  const json = readJson(target) as Record<string, unknown>;
  edit(json);
  writeFileSync(target, JSON.stringify(json, null, 2));
}

type RubricJson = { criteria: Array<Record<string, unknown>>; independentReasons: unknown[] };
type MatrixJson = {
  reviewedBy: string | null;
  reviewedAt: string | null;
  samples: Array<{
    id: string;
    criteria: Record<string, unknown>;
    mutations: Record<string, string>;
    scoreDisplay: Record<string, string>;
  }>;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("samples:check (실제 파일)", () => {
  it("rubric.v1.json이 스키마와 validateRubric()을 통과하고 배점 합이 100이다", () => {
    const rubric = RubricSchema.parse(readJson(path.join(SAMPLE_DIR, "rubric.v1.json")));
    expect(validateRubric(rubric)).toEqual({ ok: true });
    expect(rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0)).toBe(100);
    expect(rubric.criteria.every((c) => c.method.length > 0)).toBe(true);
    expect(rubric.criteria.filter((c) => c.method === "HUMAN_REVIEW").map((c) => c.id)).toEqual([
      "R-12",
    ]);
  });

  it("영역 소계가 PRD 5장 기본 배점(40/25/15/10/10)과 같다", () => {
    const rubric = RubricSchema.parse(readJson(path.join(SAMPLE_DIR, "rubric.v1.json")));
    const byArea = new Map<string, number>();
    for (const c of rubric.criteria) byArea.set(c.area, (byArea.get(c.area) ?? 0) + c.maxPoints);
    expect(Object.fromEntries(byArea)).toEqual({
      REQUIRED_FEATURES: 40,
      EDGE_AND_FAILURE: 25,
      TEST_EFFECTIVENESS: 15,
      DESIGN: 10,
      REPRODUCIBILITY_AND_DOCS: 10,
    });
  });

  it("SPEC.md에서 엔드포인트 6개와 오류 코드 5개를 읽는다", () => {
    const inventory = parseSpecInventory(readFileSync(path.join(SAMPLE_DIR, "SPEC.md"), "utf8"));
    expect(inventory.endpoints).toEqual([
      "GET /health",
      "POST /admin/reset",
      "GET /products/:id",
      "POST /orders",
      "GET /orders/:id",
      "POST /orders/:id/cancel",
    ]);
    expect(inventory.errorCodes).toEqual([
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "INSUFFICIENT_STOCK",
      "ALREADY_CANCELLED",
      "IDEMPOTENCY_CONFLICT",
    ]);
  });

  it("execution-contract.json이 티켓이 정한 값 그대로다", () => {
    expect(readJson(path.join(SAMPLE_DIR, "execution-contract.json"))).toEqual(EXPECTED_CONTRACT);
  });

  it("전체 검사가 오류 없이 통과한다 (reviewedBy 미기입은 경고)", () => {
    const report = runSampleCheck();
    expect(report.errors).toEqual([]);
    const matrix = ExpectedMatrixSchema.parse(
      readJson(path.join(SAMPLE_DIR, "expected-matrix.json")),
    );
    if (matrix.reviewedBy === null) {
      expect(report.warnings.some((w) => w.includes("reviewedBy"))).toBe(true);
    } else {
      expect(report.warnings).toEqual([]);
    }
  });
});

describe("samples:check (변형 입력)", () => {
  it("판정 조건에 라이브러리 이름이 들어가면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "rubric.v1.json", (json) => {
        const rubric = json as unknown as RubricJson;
        rubric.criteria[0]!.condition = "express 라우터로 `POST /orders`를 구현하면 201";
      }),
    );
    const report = runSampleCheck(dir);
    expect(report.errors.some((e) => e.includes("라이브러리 이름"))).toBe(true);
  });

  it("SPEC 오류 코드를 판정 조건에서 참조하지 않으면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "rubric.v1.json", (json) => {
        const rubric = json as unknown as RubricJson;
        for (const c of rubric.criteria) {
          c.condition = (c.condition as string).replaceAll("`ALREADY_CANCELLED`", "이중 취소 409");
        }
      }),
    );
    const report = runSampleCheck(dir);
    expect(report.errors).toContainEqual(expect.stringContaining("`ALREADY_CANCELLED`"));
  });

  it("R-05/R-06/R-07 independentReason이 없으면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "rubric.v1.json", (json) => {
        (json as unknown as RubricJson).independentReasons = [];
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(expect.stringContaining("independentReason"));
  });

  it("expected-matrix에서 샘플 하나가 빠지면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        matrix.samples = matrix.samples.filter((s) => s.id !== "B");
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(expect.stringContaining("샘플 B"));
  });

  it("expected-matrix에서 기준 하나가 빠지면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        delete matrix.samples[2]!.criteria["R-08"];
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(expect.stringContaining("기준 R-08"));
  });

  it("mutation 기대 결과가 빠지면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        delete matrix.samples[0]!.mutations["M-05"];
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(expect.stringContaining("mutation M-05"));
  });

  it("점수 표시가 집계 결과와 다르면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        matrix.samples[0]!.scoreDisplay.beforeHumanReview = "100/100";
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(
      expect.stringContaining("beforeHumanReview 표시가 집계 결과와 다릅니다"),
    );
  });

  it("D의 기대 판정이 C와 다르면 실패한다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        const d = matrix.samples.find((s) => s.id === "D")!;
        d.criteria["R-01"] = { verdict: "FAIL", earnedPoints: 0 };
        d.scoreDisplay.beforeHumanReview = "46~61/100 · 15점 검토 대기";
        d.scoreDisplay.withoutMutationStage = "41~66/100 · 25점 검토 대기";
      }),
    );
    expect(runSampleCheck(dir).errors).toContainEqual(
      expect.stringContaining("D의 기대 판정이 C와"),
    );
  });

  it("reviewedBy를 채우면 경고가 사라진다", () => {
    const dir = copySamples((d) =>
      editJson(d, "expected-matrix.json", (json) => {
        const matrix = json as unknown as MatrixJson;
        matrix.reviewedBy = "reviewer";
        matrix.reviewedAt = "2026-09-18T00:00:00+09:00";
      }),
    );
    const report = runSampleCheck(dir);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});
