import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SAMPLE_IDS } from "@ohmyti/db";
import { describe, expect, it } from "vitest";
import { DEMO_RECOMMENDED_ORDER, DEMO_SAMPLE_INFO, sampleCommitHref } from "./samples";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

const sampleRepos = readJson("samples/order-api/sample-repos.json") as {
  samples: Record<string, { url: string; sha: string }>;
};
const rubric = readJson("samples/order-api/rubric.v1.json") as {
  criteria: Array<{ id: string }>;
};
const expectedMatrix = readJson("samples/order-api/expected-matrix.json") as {
  samples: Array<{ id: string; mutations: Record<string, string> }>;
};

describe("T-901 샘플 설명", () => {
  it("저장소 URL과 커밋 SHA가 sample-repos.json과 같다", () => {
    for (const id of DEMO_SAMPLE_IDS) {
      const info = DEMO_SAMPLE_INFO[id];
      expect(info.repoUrl).toBe(sampleRepos.samples[id]!.url);
      expect(info.commitSha).toBe(sampleRepos.samples[id]!.sha);
      expect(sampleCommitHref(info)).toBe(`${info.repoUrl}/tree/${info.commitSha}`);
    }
  });

  it("확인할 것이 가리키는 기준 ID·변이 ID가 실제로 있다", () => {
    const criterionIds = new Set(rubric.criteria.map((c) => c.id));
    for (const id of DEMO_SAMPLE_IDS) {
      const info = DEMO_SAMPLE_INFO[id];
      const mutations = new Set(
        Object.keys(expectedMatrix.samples.find((s) => s.id === id)!.mutations),
      );
      expect(info.checks.length).toBeGreaterThanOrEqual(2);
      for (const check of info.checks) {
        expect(criterionIds, `${id} ${check.criterionId}`).toContain(check.criterionId);
        if (check.mutationId) expect(mutations).toContain(check.mutationId);
      }
    }
  });

  it("설명 문구에 판정·점수·합격 표현이 없다 (PRD 7장, G-08)", () => {
    // `PASS`·`FAIL`·점수·합격은 저장된 실행에서만 읽어 보인다
    const forbidden =
      /\bPASS\b|\bFAIL\b|INCONCLUSIVE|합격|불합격|탈락|만점|[0-9]+\s*점|[0-9]+\s*\/\s*100/;
    for (const id of DEMO_SAMPLE_IDS) {
      const info = DEMO_SAMPLE_INFO[id];
      const texts = [
        info.name,
        info.description,
        info.implementation,
        ...info.checks.map((c) => c.label),
      ];
      for (const text of texts) {
        expect(forbidden.test(text), `${id}: ${text}`).toBe(false);
      }
    }
    for (const step of DEMO_RECOMMENDED_ORDER) {
      expect(forbidden.test(`${step.title} ${step.detail}`), step.title).toBe(false);
    }
  });

  it("샘플마다 한 줄 요약과 어떤 구현인가 설명이 있다", () => {
    for (const id of DEMO_SAMPLE_IDS) {
      const info = DEMO_SAMPLE_INFO[id];
      expect(info.description.length).toBeGreaterThan(10);
      // 2~3문장
      expect(info.implementation.split(/(?<=다\.)\s/).length).toBeGreaterThanOrEqual(2);
    }
  });
});
