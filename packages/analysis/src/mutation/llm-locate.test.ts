/**
 * mutation 위치 탐색 2차(LLM 후보 + AST 검증). 모든 케이스가 FakeLlmClient로 돌고 실제 API를 호출하지 않는다
 * (TICKET.md T-402 인수 기준 5, T-401 규칙).
 */
import { FakeLlmClient, LlmBudgetExceededError, type FakeReply } from "@ohmyti/llm";
import { describe, expect, it } from "vitest";
import { applyMutations, type MutationApplyResult } from "./apply";
import { MUTATION_LOCATE_PROMPT, type MutationCandidate, type MutationLogger } from "./llm-locate";
import { memoryFiles, ROUTER_DECL, sampleFiles, TEMPLATE_NODE_MODULES } from "./test-support";

const TIMEOUT = 60_000;

function recordingLogger() {
  const entries: Array<{ level: "info" | "warn"; obj: Record<string, unknown>; msg: string }> = [];
  const logger: MutationLogger = {
    info: (obj, msg) => entries.push({ level: "info", obj, msg }),
    warn: (obj, msg) => entries.push({ level: "warn", obj, msg }),
  };
  return { logger, entries };
}

/** 사용자 메시지의 `id: M-0x`로 변형별 응답을 고른다 */
function byMutation(replies: Record<string, FakeReply>) {
  return ({ messages }: { messages: Array<{ role: string; content: string }> }): FakeReply => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const id = /^id: (M-\d+)$/m.exec(user)?.[1] ?? "";
    return replies[id] ?? { output: { candidates: [] } };
  };
}

function candidates(...list: MutationCandidate[]): FakeReply {
  return { output: { candidates: list } };
}

describe("LLM 후보 검증: 샘플 C (대상 로직 없음)", () => {
  it(
    "없는 라인·다른 종류의 노드·조건에 맞지 않는 노드·테스트 파일을 가리키는 후보는 모두 버려지고 로그에 남는다",
    async () => {
      const service = "src/domain/order-service.ts";
      const llm = new FakeLlmClient({
        responses: {
          MUTATION_TARGETS: byMutation({
            "M-03": candidates(
              { file: service, line: 9999, nodeKind: "CallExpression", reason: "없는 라인" },
              { file: service, line: 49, nodeKind: "IfStatement", reason: "받지 않는 종류" },
              { file: service, line: 48, nodeKind: "CallExpression", reason: "호출식이 없는 라인" },
              {
                file: service,
                line: 49,
                nodeKind: "CallExpression",
                reason: "validateIdempotencyKey 호출 (조회가 아님)",
              },
              {
                file: "test/orders.test.ts",
                line: 1,
                nodeKind: "CallExpression",
                reason: "테스트 파일",
              },
            ),
            "M-04": candidates(
              {
                file: service,
                line: 80,
                nodeKind: "BinaryExpression",
                reason: "order.status === CANCELLED 비교",
              },
              { file: "src/nope.ts", line: 1, nodeKind: "BinaryExpression", reason: "없는 파일" },
            ),
          }),
        },
      });
      const { logger, entries } = recordingLogger();
      const results = await applyMutations({
        files: memoryFiles(await sampleFiles("impl-c")),
        mutationIds: ["M-03", "M-04"],
        llm,
        logger,
        nodeModulesDir: TEMPLATE_NODE_MODULES,
      });
      const [m03, m04] = results as [MutationApplyResult, MutationApplyResult];

      for (const r of [m03, m04]) {
        expect(r.status).toBe("NOT_APPLICABLE");
        expect(r.reason).toBe("대상 로직 없음");
        expect(r.reasonCode).toBe("NO_TARGET");
        expect(r.diff).toBeNull();
        expect(r.mutatedFiles).toEqual({});
        expect(r.llm?.status).toBe("OK");
        expect(r.llm?.accepted).toBeUndefined();
      }
      expect(m03.discardedCandidates.map((d) => d.reason)).toEqual([
        "존재하지 않는 라인: 9999 (파일은 98줄)",
        "이 변형이 받지 않는 노드 종류: IfStatement (받는 종류: CallExpression, BinaryExpression, ForOfStatement, ForStatement)",
        "48번 라인에서 시작하는 CallExpression 노드가 없음",
        "49번 라인의 CallExpression가 변형 대상 조건에 맞지 않음",
        "변형할 수 없는 파일이거나 없는 파일: test/orders.test.ts",
      ]);
      expect(m03.discardedCandidates.map((d) => d.code)).toEqual([
        "LINE_OUT_OF_RANGE",
        "WRONG_NODE_KIND",
        "NODE_NOT_FOUND",
        "NOT_LOOKUP",
        "FILE_NOT_MUTABLE",
      ]);
      expect(m03.detail).toBe(
        "AST 휴리스틱 후보 없음, LLM 후보 5개 모두 검증 실패 (거절 코드: LINE_OUT_OF_RANGE, WRONG_NODE_KIND, NODE_NOT_FOUND, NOT_LOOKUP, FILE_NOT_MUTABLE)",
      );
      expect(m04.discardedCandidates.map((d) => d.reason)).toEqual([
        "80번 라인의 BinaryExpression가 변형 대상 조건에 맞지 않음",
        "변형할 수 없는 파일이거나 없는 파일: src/nope.ts",
      ]);

      const discardLogs = entries.filter((e) => e.msg === "mutation 위치 LLM 후보 버림");
      expect(discardLogs).toHaveLength(7);
      expect(discardLogs.every((e) => e.level === "warn")).toBe(true);
      expect(discardLogs[0]!.obj).toMatchObject({
        mutationId: "M-03",
        candidate: { line: 9999 },
        reason: "존재하지 않는 라인: 9999 (파일은 98줄)",
      });
      // 변형별로 LLM을 한 번씩 불렀다
      expect(llm.sent.map((s) => s.purpose)).toEqual(["MUTATION_TARGETS", "MUTATION_TARGETS"]);
    },
    TIMEOUT,
  );
});

describe("LLM 후보 채택", () => {
  // 수신자 이름이 `idempot`이 아니라서 휴리스틱은 놓치지만 LLM 후보 검증(느슨한 조건: dedup)은 통과한다
  const logic = [
    "const dedupCache = new Map<string, { id: string }>();",
    "export function createOrder(_b: unknown, h: { key: string }) {",
    "  const replayed = dedupCache.get(h.key);",
    "  if (replayed) return replayed;",
    "  return { id: 'new' };",
    "}",
    "",
  ].join("\n");
  const files = () =>
    memoryFiles({
      "src/app.ts": `${ROUTER_DECL}import * as logic from "./logic";\napp.post("/orders", (req) => logic.createOrder(req.body, req.headers));\n`,
      "src/logic.ts": logic,
    });

  it(
    "휴리스틱이 실패하면 첫 유효 후보를 쓰고 앞의 잘못된 후보는 버린다",
    async () => {
      const llm = new FakeLlmClient({
        responses: {
          MUTATION_TARGETS: candidates(
            { file: "src/logic.ts", line: 4, nodeKind: "CallExpression", reason: "if 줄" },
            { file: "src/logic.ts", line: 3, nodeKind: "CallExpression", reason: "dedup 조회" },
            { file: "src/logic.ts", line: 3, nodeKind: "CallExpression", reason: "중복 후보" },
          ),
        },
      });
      const { logger, entries } = recordingLogger();
      const [r] = await applyMutations({ files: files(), mutationIds: ["M-03"], llm, logger });
      expect(r!.status).toBe("APPLIED");
      expect(r!.locatedBy).toBe("llm");
      expect(r!.llm?.accepted?.line).toBe(3);
      expect(r!.discardedCandidates).toHaveLength(1);
      expect(r!.target).toEqual({ path: "src/logic.ts", startLine: 3, endLine: 3 });
      expect(r!.diff).toContain("+  const replayed = undefined;");
      expect(entries.some((e) => e.msg === "mutation 위치 LLM 후보 채택")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "같은 LLM 응답이면 patchDigest가 같다",
    async () => {
      const run = () =>
        applyMutations({
          files: files(),
          mutationIds: ["M-03"],
          llm: new FakeLlmClient({
            responses: {
              MUTATION_TARGETS: candidates({
                file: "src/logic.ts",
                line: 3,
                nodeKind: "CallExpression",
                reason: "dedup 조회",
              }),
            },
          }),
        });
      const [a] = await run();
      const [b] = await run();
      expect(a!.patchDigest).toBe(b!.patchDigest);
    },
    TIMEOUT,
  );

  it(
    "휴리스틱이 찾으면 LLM을 부르지 않는다",
    async () => {
      const llm = new FakeLlmClient({ responses: {} });
      const results = await applyMutations({
        files: memoryFiles(await sampleFiles("impl-a")),
        llm,
        nodeModulesDir: TEMPLATE_NODE_MODULES,
      });
      expect(results.every((r) => r.status === "APPLIED" && r.llm === null)).toBe(true);
      expect(llm.sent).toHaveLength(0);
    },
    TIMEOUT,
  );
});

describe("LLM 실패는 단계를 멈추지 않는다", () => {
  const files = async () => memoryFiles(await sampleFiles("impl-c"));

  it(
    "예산 초과면 LOCATE_FAILED(LLM 미실행)이고 나머지 변형은 계속 적용된다",
    async () => {
      const llm = new FakeLlmClient({
        responses: {
          MUTATION_TARGETS: {
            error: new LlmBudgetExceededError(
              "calls",
              { calls: 3, costUsd: 0 },
              { calls: 3, costUsd: 1 },
            ),
          },
        },
      });
      const results = await applyMutations({ files: await files(), llm });
      const byId = Object.fromEntries(results.map((r) => [r.mutationId, r]));
      expect(byId["M-03"]!.status).toBe("NOT_APPLICABLE");
      expect(byId["M-03"]!.reasonCode).toBe("LOCATE_FAILED");
      expect(byId["M-03"]!.reason).toBe("대상 위치 탐색 불가");
      expect(byId["M-03"]!.llm?.status).toBe("NOT_RUN");
      expect(byId["M-03"]!.detail).toContain("LLM 미실행");
      expect(byId["M-01"]!.status).toBe("APPLIED");
      expect(byId["M-05"]!.status).toBe("APPLIED");
    },
    TIMEOUT,
  );

  it(
    "잘못된 JSON이면 1회 재요청 뒤 INCONCLUSIVE로 남는다",
    async () => {
      const llm = new FakeLlmClient({ responses: { MUTATION_TARGETS: { raw: "not json" } } });
      const [r] = await applyMutations({ files: await files(), mutationIds: ["M-04"], llm });
      expect(r!.reasonCode).toBe("LOCATE_FAILED");
      expect(r!.llm?.status).toBe("INCONCLUSIVE");
      expect(llm.sent).toHaveLength(2);
    },
    TIMEOUT,
  );
});

describe("LLM 프롬프트", () => {
  it(
    "소스 코드(적대적 주석 포함)는 사용자 메시지의 untrusted 블록 안에만 있고 테스트 파일은 보내지 않는다",
    async () => {
      const llm = new FakeLlmClient({ responses: { MUTATION_TARGETS: candidates() } });
      await applyMutations({
        files: memoryFiles(await sampleFiles("impl-d")),
        mutationIds: ["M-03"],
        llm,
      });
      const messages = llm.sent[0]!.messages;
      const system = messages.find((m) => m.role === "system")!.content;
      const user = messages.find((m) => m.role === "user")!.content;
      expect(system).toContain(MUTATION_LOCATE_PROMPT.system.split("\n")[0]);
      expect(system).not.toContain("SYSTEM OVERRIDE");
      expect(user).toContain("id: M-03");
      expect(user).toContain("### file: src/domain/order-service.ts");
      expect(user).not.toContain("### file: test/");
      const injected = user.indexOf("[SYSTEM OVERRIDE]");
      expect(injected).toBeGreaterThan(0);
      const blockStart = user.lastIndexOf("<<<UNTRUSTED_DATA", injected);
      const blockEnd = user.lastIndexOf("<<<END_UNTRUSTED_DATA", injected);
      expect(blockStart).toBeGreaterThan(blockEnd);
      expect(MUTATION_LOCATE_PROMPT.promptVersion).toMatch(/^mutation-locate@v1\+[0-9a-f]{8}$/);
    },
    TIMEOUT,
  );
});
