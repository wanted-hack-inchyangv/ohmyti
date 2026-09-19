/**
 * mutation 위치 탐색 2차: LLM 후보 제안 + AST 검증 (TICKET.md T-402, 1.5의 2번 용도).
 *
 * LLM은 `{ file, line, nodeKind, reason }` 후보만 제안한다. 적용 여부는 AST가 정한다: 파일이 변형 가능한 소스인지,
 * 라인이 존재하는지, 주장한 종류가 이 변형이 받는 종류인지, 그 라인에서 시작하는 그 종류의 노드가 있는지,
 * 카탈로그의 느슨한 조건(`llmAccept`)을 통과하는지 차례로 확인하고, 하나라도 어긋나면 사유와 함께 버린다.
 * 소스 코드(주석 포함)는 제출자가 쓴 데이터이므로 `untrusted()`로 감싸 보낸다 (G-06).
 */
import {
  definePrompt,
  llmStepOutcome,
  untrusted,
  type LlmClient,
  type LlmStepOutcome,
} from "@ohmyti/llm";
import type { Node, SourceFile } from "ts-morph";
import { z } from "zod";
import { isRejection, type MutationDefinition, type MutationRejectCode } from "./catalog";

export const MUTATION_LOCATE_PROMPT = definePrompt({
  purpose: "MUTATION_TARGETS",
  id: "mutation-locate",
  version: 1,
  system: [
    "너는 TypeScript 코드에서 결함 주입(mutation) 대상 위치를 찾는 보조 도구다.",
    "사용자 메시지에 변형 설명, 찾을 노드 종류, 라인 번호가 붙은 소스 파일이 주어진다.",
    "변형 설명에 맞는 코드가 실제로 있을 때만 후보를 낸다. 해당 로직이 없으면 candidates를 빈 배열로 둔다. 추측으로 위치를 만들지 않는다.",
    "file은 주어진 파일 경로 그대로, line은 그 노드가 시작하는 라인 번호(파일 안 번호), nodeKind는 주어진 노드 종류 중 하나로 쓴다.",
    "후보는 가능성이 높은 순서로 최대 3개까지 낸다. reason에는 그 위치를 고른 근거를 한 문장으로 쓴다.",
    "점수·판정·합격 여부는 쓰지 않는다.",
  ].join("\n"),
});

export const MutationCandidateSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int(),
  nodeKind: z.string().min(1).max(64),
  reason: z.string().max(500),
});
export type MutationCandidate = z.infer<typeof MutationCandidateSchema>;

export const MutationCandidatesSchema = z.object({
  candidates: z.array(MutationCandidateSchema).max(5),
});
export type MutationCandidates = z.infer<typeof MutationCandidatesSchema>;

/** 프롬프트에 넣는 소스 총 글자 수 상한. 넘는 파일은 빼고 뺀 수를 알린다 */
export const LLM_SOURCE_MAX_CHARS = 60_000;
export const MUTATION_LOCATE_MAX_TOKENS = 1_024;

export interface DiscardedCandidate {
  candidate: MutationCandidate;
  /** 거절 코드 (`NOT_APPLICABLE` 사유에 붙는다) */
  code: MutationRejectCode;
  reason: string;
}

/** pino와 호환되는 최소 로거 */
export interface MutationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LocateSourceFile {
  path: string;
  sourceFile: SourceFile;
}

export interface LlmLocateResult {
  /** 첫 유효 후보의 변형 대상 노드 */
  target?: { node: Node; candidate: MutationCandidate } | undefined;
  discarded: DiscardedCandidate[];
  outcome: LlmStepOutcome<MutationCandidates>;
}

/** 파일 끝 줄바꿈 뒤의 빈 줄은 세지 않는다 (프롬프트의 라인 번호와 같게) */
function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function numbered(text: string): string {
  const lines = sourceLines(text);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width, " ")}| ${line}`).join("\n");
}

/** 사용자 메시지. 파일 경로는 출력 형식을 흔들 수 없도록 인쇄 가능한 문자만 남긴다 */
export function buildLocateInput(
  definition: MutationDefinition,
  files: LocateSourceFile[],
): string {
  const parts = [
    "## 변형",
    `id: ${definition.id}`,
    `설명: ${definition.description}`,
    `찾을 대상: ${definition.llmHint}`,
    `받는 nodeKind: ${definition.locate.llmNodeKinds.join(", ")}`,
    "## 소스 파일 (라인 번호 포함, 테스트 파일 제외)",
  ];
  let used = 0;
  let omitted = 0;
  for (const file of files) {
    const text = file.sourceFile.getFullText();
    if (used + text.length > LLM_SOURCE_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    used += text.length;
    const safePath = file.path.replace(/[^\x20-\x7e]/g, "?");
    parts.push(`### file: ${safePath}`, untrusted(`source:${safePath}`, numbered(text)));
  }
  if (omitted > 0) parts.push(`(크기 상한으로 ${omitted}개 파일을 넣지 않았다)`);
  return parts.join("\n\n");
}

/** 후보 하나를 검증한다. 통과하면 변형 대상 노드, 아니면 거절 코드와 버리는 사유 */
export function validateCandidate(
  definition: MutationDefinition,
  candidate: MutationCandidate,
  filesByPath: ReadonlyMap<string, SourceFile>,
): { node: Node } | { code: MutationRejectCode; reason: string } {
  const sourceFile = filesByPath.get(candidate.file);
  if (!sourceFile) {
    return {
      code: "FILE_NOT_MUTABLE",
      reason: `변형할 수 없는 파일이거나 없는 파일: ${candidate.file}`,
    };
  }
  const lineCount = sourceLines(sourceFile.getFullText()).length;
  if (candidate.line < 1 || candidate.line > lineCount) {
    return {
      code: "LINE_OUT_OF_RANGE",
      reason: `존재하지 않는 라인: ${candidate.line} (파일은 ${lineCount}줄)`,
    };
  }
  const kinds: readonly string[] = definition.locate.llmNodeKinds;
  if (!kinds.includes(candidate.nodeKind)) {
    return {
      code: "WRONG_NODE_KIND",
      reason: `이 변형이 받지 않는 노드 종류: ${candidate.nodeKind} (받는 종류: ${kinds.join(", ")})`,
    };
  }
  const nodes: Node[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKindName() === candidate.nodeKind && node.getStartLineNumber() === candidate.line) {
      nodes.push(node);
    }
  });
  if (nodes.length === 0) {
    return {
      code: "NODE_NOT_FOUND",
      reason: `${candidate.line}번 라인에서 시작하는 ${candidate.nodeKind} 노드가 없음`,
    };
  }
  let firstRejection: MutationRejectCode | undefined;
  for (const node of nodes) {
    const accepted = definition.locate.llmAccept(node);
    if (!isRejection(accepted)) return { node: accepted };
    firstRejection ??= accepted.reject;
  }
  return {
    code: firstRejection!,
    reason: `${candidate.line}번 라인의 ${candidate.nodeKind}가 변형 대상 조건에 맞지 않음`,
  };
}

export async function locateWithLlm(input: {
  definition: MutationDefinition;
  llm: LlmClient;
  files: LocateSourceFile[];
  logger?: MutationLogger | undefined;
}): Promise<LlmLocateResult> {
  const { definition, llm, files, logger } = input;
  const outcome = await llmStepOutcome(async () => {
    const result = await llm.complete({
      purpose: MUTATION_LOCATE_PROMPT.purpose,
      promptVersion: MUTATION_LOCATE_PROMPT.promptVersion,
      system: MUTATION_LOCATE_PROMPT.system,
      input: buildLocateInput(definition, files),
      schema: MutationCandidatesSchema,
      example: {
        candidates: [
          {
            file: "src/example.ts",
            line: 12,
            nodeKind: definition.locate.llmNodeKinds[0] ?? "BinaryExpression",
            reason: "예시 형식이다. 실제 위치가 아니다",
          },
        ],
      },
      maxTokens: MUTATION_LOCATE_MAX_TOKENS,
    });
    return result.output;
  });
  const discarded: DiscardedCandidate[] = [];
  if (outcome.status !== "OK") {
    logger?.warn(
      { mutationId: definition.id, status: outcome.status, reason: outcome.reason },
      "mutation 위치 LLM 탐색 실패",
    );
    return { discarded, outcome };
  }
  const filesByPath = new Map(files.map((file) => [file.path, file.sourceFile]));
  for (const candidate of outcome.value.candidates) {
    const checked = validateCandidate(definition, candidate, filesByPath);
    if ("node" in checked) {
      logger?.info({ mutationId: definition.id, candidate }, "mutation 위치 LLM 후보 채택");
      return { target: { node: checked.node, candidate }, discarded, outcome };
    }
    discarded.push({ candidate, code: checked.code, reason: checked.reason });
    logger?.warn(
      { mutationId: definition.id, candidate, code: checked.code, reason: checked.reason },
      "mutation 위치 LLM 후보 버림",
    );
  }
  return { discarded, outcome };
}
