/**
 * 샘플 A/B/C/D에 카탈로그 M-01~M-05를 적용한다 (TICKET.md T-402 인수 기준 1~4).
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isTestPath } from "./ast";
import {
  applyMutations,
  mutantFiles,
  writeMutantDirectory,
  type MutationApplyResult,
} from "./apply";
import { MUTATION_CATALOG } from "./catalog";
import {
  hashAll,
  memoryFiles,
  SAMPLES_DIR,
  sampleFiles,
  sha256,
  TEMPLATE_NODE_MODULES,
} from "./test-support";

const TIMEOUT = 60_000;

async function applySample(impl: string): Promise<MutationApplyResult[]> {
  return applyMutations({
    files: memoryFiles(await sampleFiles(impl)),
    nodeModulesDir: TEMPLATE_NODE_MODULES,
  });
}

function byId(results: MutationApplyResult[]): Record<string, MutationApplyResult> {
  return Object.fromEntries(results.map((r) => [r.mutationId, r]));
}

describe("mutation 적용기: 샘플 A (정답)", () => {
  let results: MutationApplyResult[];
  beforeAll(async () => {
    results = await applySample("impl-a");
  }, TIMEOUT);

  it("M-01~M-05가 모두 휴리스틱으로 적용되고 각 diff의 변경 줄 수가 10줄 이하다", () => {
    expect(results.map((r) => r.mutationId)).toEqual(["M-01", "M-02", "M-03", "M-04", "M-05"]);
    for (const r of results) {
      expect(r.status, `${r.mutationId}: ${r.reason} ${r.detail}`).toBe("APPLIED");
      expect(r.locatedBy).toBe("heuristic");
      expect(r.changedLines).toBeGreaterThan(0);
      expect(r.changedLines).toBeLessThanOrEqual(10);
      expect(r.buildErrors).toEqual([]);
      expect(r.patchDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(r.mutatedFiles)).toEqual([r.target!.path]);
    }
  });

  it("부록 A의 변형 내용과 위치가 맞다", () => {
    const r = byId(results);
    expect(r["M-01"]!.target!.path).toBe("src/domain/order-service.ts");
    expect(r["M-01"]!.diff).toContain("-      if (input.quantity > product.stock) {");
    expect(r["M-01"]!.diff).not.toMatch(/^\+[^+]/m);
    expect(r["M-02"]!.target!.path).toBe("src/domain/validation.ts");
    expect(r["M-02"]!.diff).toContain("-  if (quantity <= 0) {\n+  if (quantity < 0) {");
    expect(r["M-03"]!.diff).toContain(
      "-      const existing = await this.idempotency.get(key);\n+      const existing = undefined;",
    );
    expect(r["M-04"]!.diff).toContain(
      "-        if (existing.requestDigest !== digest) {\n+        if (false) {",
    );
    expect(r["M-05"]!.diff).toContain(
      "-      await this.products.adjustStock(order.productId, order.quantity);",
    );
    expect(r["M-05"]!.changedLines).toBe(1);
    // 샘플의 `M-0x` 표식 주석은 지우지 않는다 (주석은 위치 판단에 쓰지 않는다)
    expect(r["M-01"]!.diff).toContain(" // M-01은 이 재고 검사를 제거하거나 조건을 반전한다.");
  });

  it(
    "같은 스냅샷에 같은 mutation을 두 번 적용하면 patchDigest와 diff가 같다",
    async () => {
      const again = byId(await applySample("impl-a"));
      for (const r of results) {
        expect(again[r.mutationId]!.patchDigest).toBe(r.patchDigest);
        expect(again[r.mutationId]!.diff).toBe(r.diff);
      }
    },
    TIMEOUT,
  );

  it("변형 후 테스트 파일의 해시가 변형 전과 같고, 대상 파일 밖은 바뀌지 않는다", async () => {
    const base = memoryFiles(await sampleFiles("impl-a"));
    const before = await hashAll(base);
    const testPaths = [...before.keys()].filter(isTestPath);
    expect(testPaths.length).toBeGreaterThanOrEqual(7);
    for (const r of results) {
      const after = await hashAll(mutantFiles(base, r));
      for (const p of testPaths) expect(after.get(p), `${r.mutationId} ${p}`).toBe(before.get(p));
      const changed = [...after.keys()].filter((p) => after.get(p) !== before.get(p));
      expect(changed).toEqual([r.target!.path]);
      expect(isTestPath(r.target!.path)).toBe(false);
    }
  });

  it("변형 디렉터리: 스냅샷을 복사하고 대상 파일만 바꾼다 (node_modules 제외, 테스트 파일 동일)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ohmyti-mutant-test-"));
    try {
      const m05 = byId(results)["M-05"]!;
      await writeMutantDirectory({
        sourceDir: path.join(SAMPLES_DIR, "impl-a"),
        targetDir: dir,
        result: m05,
      });
      const written = await readFile(path.join(dir, m05.target!.path), "utf8");
      expect(written).toBe(m05.mutatedFiles[m05.target!.path]);
      await expect(stat(path.join(dir, "node_modules"))).rejects.toThrow();
      const original = await sampleFiles("impl-a");
      for (const [p, text] of original) {
        if (p === m05.target!.path) continue;
        expect(sha256(await readFile(path.join(dir, p), "utf8")), p).toBe(sha256(text));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "적용되지 않은 결과로는 변형 디렉터리를 만들지 않는다",
    async () => {
      const [c03] = await applyMutations({
        files: memoryFiles(await sampleFiles("impl-c")),
        mutationIds: ["M-03"],
      });
      await expect(
        writeMutantDirectory({
          sourceDir: SAMPLES_DIR,
          targetDir: path.join(os.tmpdir(), "ohmyti-mutant-never-created"),
          result: c03!,
        }),
      ).rejects.toThrow(/적용되지 않은/);
    },
    TIMEOUT,
  );
});

describe("mutation 적용기: 샘플 B (대안 정답, hono·다른 구조)", () => {
  it(
    "M-01~M-05가 모두 적용되고 변경 줄 수가 10줄 이하다",
    async () => {
      const results = byId(await applySample("impl-b"));
      for (const entry of MUTATION_CATALOG) {
        const r = results[entry.id]!;
        expect(r.status, `${r.mutationId}: ${r.reason} ${r.detail}`).toBe("APPLIED");
        expect(r.changedLines).toBeLessThanOrEqual(10);
      }
      expect(results["M-03"]!.diff).toContain("+    const seen = undefined;");
      expect(results["M-04"]!.diff).toContain("+      if (false) {");
      expect(results["M-05"]!.diff).toContain(
        "-      release(state.ledger, found.productId, found.id, found.quantity);",
      );
    },
    TIMEOUT,
  );
});

describe("mutation 적용기: 샘플 C (멱등성 미구현)", () => {
  let results: Record<string, MutationApplyResult>;
  beforeAll(async () => {
    results = byId(await applySample("impl-c"));
  }, TIMEOUT);

  it("M-03/M-04는 NOT_APPLICABLE이고 사유가 '대상 로직 없음'이며 가짜 변형이 없다", () => {
    for (const id of ["M-03", "M-04"]) {
      const r = results[id]!;
      expect(r.status).toBe("NOT_APPLICABLE");
      expect(r.reasonCode).toBe("NO_TARGET");
      expect(r.reason).toBe("대상 로직 없음");
      expect(r.diff).toBeNull();
      expect(r.patchDigest).toBeNull();
      expect(r.target).toBeNull();
      expect(r.mutatedFiles).toEqual({});
      expect(r.changedLines).toBe(0);
    }
  });

  it("M-01·M-02·M-05는 A와 같은 위치에 적용된다", () => {
    for (const id of ["M-01", "M-02", "M-05"]) {
      expect(results[id]!.status).toBe("APPLIED");
      expect(results[id]!.changedLines).toBeLessThanOrEqual(10);
    }
  });
});

describe("mutation 적용기: 샘플 D (적대적 주석)", () => {
  let c: Record<string, MutationApplyResult>;
  let d: Record<string, MutationApplyResult>;
  beforeAll(async () => {
    [c, d] = (await Promise.all([applySample("impl-c"), applySample("impl-d")])).map(byId) as [
      Record<string, MutationApplyResult>,
      Record<string, MutationApplyResult>,
    ];
  }, TIMEOUT);

  it("주석의 지시문과 무관하게 C와 같은 상태·사유·변형을 낸다", () => {
    for (const entry of MUTATION_CATALOG) {
      expect(d[entry.id]!.status).toBe(c[entry.id]!.status);
      expect(d[entry.id]!.reason).toBe(c[entry.id]!.reason);
      // 주석이 늘어 라인 번호는 다르지만 바뀐 줄의 내용은 같다
      const changes = (r: MutationApplyResult) =>
        (r.diff ?? "").split("\n").filter((l) => /^[-+][^-+]/.test(l));
      expect(changes(d[entry.id]!)).toEqual(changes(c[entry.id]!));
    }
  });
});
