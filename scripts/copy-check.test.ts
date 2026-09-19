import { describe, expect, it } from "vitest";
import { checkCopy, findForbiddenCopy } from "./copy-check";

const rulesOf = (text: string) => findForbiddenCopy(text, "x.tsx").map((v) => v.rule);

describe("findForbiddenCopy", () => {
  it('"조작 불가능" 류 표현을 찾는다', () => {
    for (const text of [
      "조작 불가능한 채점",
      "점수는 조작이 불가능합니다",
      "누구도 조작할 수 없는 결과",
      "위변조 불가 기록",
      "Tamper-proof grading",
    ]) {
      expect(rulesOf(text), text).toEqual(["TAMPER_PROOF"]);
    }
  });

  it("정확도·비용 절감·속도 수치를 찾는다", () => {
    expect(rulesOf("채점 정확도 98%")).toEqual(["ACCURACY_FIGURE"]);
    expect(rulesOf("99.5% 정확한 판정")).toEqual(["ACCURACY_FIGURE"]);
    expect(rulesOf("채용 비용 70% 절감")).toEqual(["COST_FIGURE"]);
    expect(rulesOf("검토 비용을 3배 줄입니다")).toEqual(["COST_FIGURE"]);
    expect(rulesOf("기존보다 10배 빠른 리뷰")).toEqual(["SPEED_FIGURE"]);
    expect(rulesOf("5분 만에 채점 완료")).toEqual(["SPEED_FIGURE"]);
    expect(rulesOf("3x faster reviews")).toEqual(["SPEED_FIGURE"]);
  });

  it("조작 시도 설명, 배점, 90초 데모, 점수 표시 같은 정상 문구는 허용한다", () => {
    for (const text of [
      "C와 같은 결함에 README·주석·점수 파일로 채점을 조작하려는 문구를 넣은 샘플",
      "버전이 고정되고 검토 가능한 실행 근거",
      "54~69/100 · 15점 검토 대기",
      "90초 데모 시나리오",
      "요청 제한 시간 5000ms",
      "테스트 실효성 15/15",
      "비용 상한 LLM_MAX_COST_USD_PER_EVALUATION",
    ]) {
      expect(rulesOf(text), text).toEqual([]);
    }
  });

  it("줄 번호와 일치 문자열을 기록한다", () => {
    expect(findForbiddenCopy("첫 줄\n정확도 95% 달성", "a.md")).toEqual([
      { file: "a.md", line: 2, rule: "ACCURACY_FIGURE", text: "정확도 95%" },
    ]);
  });
});

describe("checkCopy", () => {
  it("저장소의 UI 문구·문서에 금지 표현이 없다", async () => {
    const { files, violations } = await checkCopy();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))).toBe(false);
    expect(violations).toEqual([]);
  });
});
