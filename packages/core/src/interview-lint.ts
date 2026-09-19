/**
 * 인터뷰 질문 검사 (TICKET.md T-701, PRD 14.2). LLM이 쓴 질문과 기본 질문 모두에 같은 결정적 규칙을 적용한다.
 *
 * - 주 질문과 꼬리 질문은 항목마다 "질문 하나"여야 한다. 물음표가 2개 이상이거나 의문 절이 둘 이상이면 복합 질문이다.
 *   의문 절은 형태소 분석 없이 종결·연결 어미 패턴으로 센다(`나요`·`까요`·`습니까`·`는지` 등).
 *   질문 앞에 평서문 도입 한 문장은 허용한다("R-06 재생 기록을 함께 보겠습니다. …짚어 주시겠어요?", 결정 로그 T-701).
 * - 추궁 어조("왜 … 않았", "못 하셨", "설명해야")와 진위 추궁, 개인 신상·차별 소지 주제, 맥락 연결 금지 표현을 걸러낸다.
 * - 근거 참조가 없는 질문은 위반이다.
 * - 검사는 문장 안의 표현만 본다. 문장이 좋은 질문인지(의도·난이도)는 판단하지 않는다.
 */
import { z } from "zod";
import { findForbiddenContextExpression } from "./context-link";

/** 주 질문·꼬리 질문 한 항목의 길이 상한 (글자 수) */
export const INTERVIEW_QUESTION_MAX_CHARS = 160;
/** 질문 앞의 평서문 도입을 포함한 문장 수 상한 */
export const INTERVIEW_QUESTION_MAX_SENTENCES = 2;

export const InterviewLintRuleSchema = z.enum([
  "MULTIPLE_QUESTION_MARKS",
  "COMPOUND_QUESTION",
  "TOO_MANY_SENTENCES",
  "TOO_LONG",
  "ACCUSATORY_TONE",
  "VERACITY_CHALLENGE",
  "PERSONAL_TOPIC",
  "FORBIDDEN_EXPRESSION",
  "NO_REFS",
]);
export type InterviewLintRule = z.infer<typeof InterviewLintRuleSchema>;

export const InterviewLintFieldSchema = z.enum([
  "question",
  "probes",
  "intent",
  "positiveSignals",
  "concernSignals",
  "refs",
]);
export type InterviewLintField = z.infer<typeof InterviewLintFieldSchema>;

export const InterviewLintViolationSchema = z.strictObject({
  field: InterviewLintFieldSchema,
  /** 배열 필드(`probes`·신호)의 위치. 단일 필드면 null */
  index: z.int().min(0).nullable(),
  rule: InterviewLintRuleSchema,
  /** 걸린 표현이나 주제 라벨. 질문 본문 전체는 담지 않는다 */
  note: z.string().optional(),
});
export type InterviewLintViolation = z.infer<typeof InterviewLintViolationSchema>;

// ---------------------------------------------------------------------------
// 의문 절 세기

/** 의문사. 연결 어미 앞 절에 의문사가 있으면 그 절도 질문이다("어떤 저장소로 구현했고, … 어떻게 달랐나요?") */
const INTERROGATIVE_WORD = /(?:^|[\s(,])(?:어떤|어떻게|어떠|어느|왜|무엇|무슨|뭐|뭘|언제|어디|누가|누구|몇|얼마)/;

/** 의문 절을 끝내는 연결 어미 + 쉼표, 또는 과거 시제 연결 어미 `-고` */
const CLAUSE_CONNECTIVE = /(?:[가-힣](?:고|며|으며|는데|은데|인데|지만|거나)\s*,|(?:했|였|었|았|웠|됐|셨)고\s)/g;

/** 문장 끝의 의문 어미 (물음표가 없어도 질문으로 본다) */
const QUESTION_ENDING = /(?:나요|까요|가요|습니까|니까|는가|은가|인가|을까|할까|죠|지요|어요|아요|해요|래요|나|니|냐)\s*[?？]$|(?:나요|까요|가요|습니까|는가요|인가요)\s*[.。]?$/;

/** 요청 형태의 문장 끝. 앞의 내포 의문절(`-는지`)이 실제 질문이다 */
const REQUEST_ENDING =
  /(?:주시겠어요|주시겠습니까|주시겠나요|주실\s*수\s*있(?:을까요|나요|습니까|으신가요)|주실래요|주세요|주십시오|부탁드립니다|궁금합니다)\s*[?？.。]?$/;

/** 내포 의문절 어미: "어떤 기준으로 정했는지", "무엇을 할지" */
const EMBEDDED_QUESTION = /(?:는|은|인|던|을|할|될|일|했을|였을)지(?=[\s,.?？와과를을도가만]|$)/g;

/** 쉼표가 뒤따르는 내포 의문절: 질문 문장 안에서 나열된 두 번째 질문 */
const LISTED_EMBEDDED_QUESTION = /(?:는|은|인|던|을|할|될|일|했을|였을)지\s*(?:,|와|과|하고|그리고)\s/g;

function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.?!？。])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** 연결 어미로 나눈 앞 절 중 의문사를 가진 절 수 (마지막 절은 문장 끝 어미로 센다) */
function countInterrogativeLeadClauses(sentence: string): number {
  const segments = sentence.split(CLAUSE_CONNECTIVE);
  return segments.slice(0, -1).filter((segment) => INTERROGATIVE_WORD.test(segment)).length;
}

/**
 * 문장 하나에 들어 있는 질문 수.
 * - 요청 문장("…는지 설명해 주시겠어요?"): 내포 의문절 수(없으면 1)
 * - 질문 문장("…나요?"): 1 + 쉼표로 나열된 내포 의문절 수 + 의문사가 있는 앞 절 수
 * - 평서문: 0
 */
export function countQuestionClauses(sentence: string): number {
  const text = sentence.trim();
  if (REQUEST_ENDING.test(text)) {
    return Math.max(1, countMatches(text, EMBEDDED_QUESTION)) + countInterrogativeLeadClauses(text);
  }
  if (QUESTION_ENDING.test(text) || /[?？]$/.test(text)) {
    return 1 + countMatches(text, LISTED_EMBEDDED_QUESTION) + countInterrogativeLeadClauses(text);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 어조·주제 규칙

interface LabeledPattern {
  label: string;
  pattern: RegExp;
}

/** 추궁 어조: 하지 않은 일의 이유를 캐묻거나 해명을 요구한다 */
export const ACCUSATORY_PATTERNS: readonly LabeledPattern[] = [
  { label: "왜 … 않았", pattern: /왜[^?？.]*?(?:않았|않으셨|안\s*했|안\s*하셨|못\s*했|못\s*하셨|없었|빠뜨|누락)/ },
  { label: "못 하셨", pattern: /못\s*하셨|못\s*하신/ },
  { label: "설명해야", pattern: /설명해야|해명|변명/ },
  { label: "잘못", pattern: /(?:본인|지원자)[^?？.]*잘못/ },
];

/** 진위 추궁: 본인이 한 일인지, 이력서가 사실인지 확인하려 든다 */
export const VERACITY_PATTERNS: readonly LabeledPattern[] = [
  { label: "정말 본인이", pattern: /정말(?:로)?\s*(?:본인이|직접|하셨|하신|맞)/ },
  { label: "실제로 본인이", pattern: /실제로\s*본인이|본인이\s*(?:직접\s*)?(?:작성|구현|개발)한\s*(?:게|것이|것)\s*맞/ },
  { label: "사실인지", pattern: /사실인지|사실입니까|사실인가요|사실이\s*맞/ },
  { label: "증명", pattern: /증명해|입증해|증명할\s*수|입증할\s*수/ },
];

/** 개인 신상·차별 소지 주제. 기술 문장의 흔한 단어(나이브, 멱등 키가, 장애 대응, 헬스 체크)와 겹치지 않게 좁힌다 */
export const PERSONAL_TOPIC_PATTERNS: readonly LabeledPattern[] = [
  { label: "나이", pattern: /나이(?!브)|연세|몇\s*살|생년|출생\s*연도|[1-9]0대\s*(?:초|중|후)반/ },
  { label: "결혼·출산", pattern: /결혼|기혼|미혼|배우자|출산|임신|육아|자녀(?:가|는|를|분|\s*계획)|아이\s*계획/ },
  { label: "출신 지역", pattern: /출신|고향|본적|어느\s*지역\s*(?:분|사람)/ },
  {
    label: "출신 학교",
    pattern: /학벌|학점|어느\s*(?:학교|대학)|(?:학교|대학)(?:는|은|가|이)?\s*어디/,
  },
  {
    label: "건강",
    pattern: /(?<!(?:서버|서비스|시스템|인스턴스|노드|컨테이너|클러스터|DB)(?:의)?\s?)건강(?:\s*(?:상태|문제|검진)|이|은|을)|질병|병력|지병|투병|복용|장애인|장애\s*등급|(?:신체|정신)\s*장애/,
  },
  { label: "종교", pattern: /종교|신앙|교회|성당|사찰|절에\s*다니/ },
  { label: "병역", pattern: /병역|군필|미필|군\s*복무|군대|전역|입대|군\s*면제/ },
  { label: "가족", pattern: /가족|부모님|형제|자매/ },
  { label: "정치", pattern: /정치\s*성향|지지\s*정당|지지하는\s*정당|투표/ },
  { label: "성별", pattern: /성별|성적\s*지향|여자라서|남자라서/ },
  { label: "외모", pattern: /외모|체중|몸무게/ },
];

function firstLabel(text: string, patterns: readonly LabeledPattern[]): string | null {
  for (const { label, pattern } of patterns) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 공개 검사 함수

/** 표현 규칙(어조·신상·금지 표현). 질문이 아닌 문장(의도·신호)에도 적용한다 */
function lintExpression(text: string): Array<{ rule: InterviewLintRule; note: string }> {
  const found: Array<{ rule: InterviewLintRule; note: string }> = [];
  const accusatory = firstLabel(text, ACCUSATORY_PATTERNS);
  if (accusatory) found.push({ rule: "ACCUSATORY_TONE", note: accusatory });
  const veracity = firstLabel(text, VERACITY_PATTERNS);
  if (veracity) found.push({ rule: "VERACITY_CHALLENGE", note: veracity });
  const personal = firstLabel(text, PERSONAL_TOPIC_PATTERNS);
  if (personal) found.push({ rule: "PERSONAL_TOPIC", note: personal });
  const forbidden = findForbiddenContextExpression(text);
  if (forbidden) found.push({ rule: "FORBIDDEN_EXPRESSION", note: forbidden });
  return found;
}

/**
 * 질문 문장 하나(주 질문 또는 꼬리 질문 한 항목)의 위반 규칙. 위반이 없으면 빈 배열이다.
 * 이력서 연결 질문(T-703)도 이 함수로 검사한다.
 */
export function lintQuestionText(text: string): Array<{ rule: InterviewLintRule; note?: string }> {
  const found: Array<{ rule: InterviewLintRule; note?: string }> = [];
  const questionMarks = countMatches(text, /[?？]/g);
  if (questionMarks >= 2) {
    found.push({ rule: "MULTIPLE_QUESTION_MARKS", note: `물음표 ${questionMarks}개` });
  }
  const sentences = splitSentences(text);
  const clauses = sentences.reduce((sum, sentence) => sum + countQuestionClauses(sentence), 0);
  if (clauses >= 2) found.push({ rule: "COMPOUND_QUESTION", note: `의문 절 ${clauses}개` });
  if (sentences.length > INTERVIEW_QUESTION_MAX_SENTENCES) {
    found.push({ rule: "TOO_MANY_SENTENCES", note: `${sentences.length}문장` });
  }
  if ([...text].length > INTERVIEW_QUESTION_MAX_CHARS) {
    found.push({ rule: "TOO_LONG", note: `${[...text].length}자` });
  }
  found.push(...lintExpression(text));
  return found;
}

/** 검사 대상 질문. `InterviewQuestion`의 부분 집합이라 LLM 초안·기본 질문·이력서 연결 질문에 모두 쓸 수 있다 */
export interface LintableInterviewQuestion {
  question: string;
  probes?: readonly string[];
  intent?: string;
  positiveSignals?: readonly string[];
  concernSignals?: readonly string[];
  /** 근거 참조. 비어 있으면 `NO_REFS` */
  refs: readonly unknown[];
}

/**
 * 인터뷰 질문 검사 (결정적). 주 질문과 꼬리 질문은 항목마다 질문 규칙 전체를, 의도와 신호는 표현 규칙(어조·신상·금지 표현)을
 * 적용한다. 위반이 없으면 빈 배열이다.
 */
export function lintInterviewQuestion(input: LintableInterviewQuestion): InterviewLintViolation[] {
  const violations: InterviewLintViolation[] = [];
  const push = (
    field: InterviewLintField,
    index: number | null,
    found: Array<{ rule: InterviewLintRule; note?: string }>,
  ) => {
    for (const { rule, note } of found) {
      violations.push(note === undefined ? { field, index, rule } : { field, index, rule, note });
    }
  };
  push("question", null, lintQuestionText(input.question));
  input.probes?.forEach((probe, index) => push("probes", index, lintQuestionText(probe)));
  if (input.intent !== undefined) push("intent", null, lintExpression(input.intent));
  input.positiveSignals?.forEach((signal, index) =>
    push("positiveSignals", index, lintExpression(signal)),
  );
  input.concernSignals?.forEach((signal, index) =>
    push("concernSignals", index, lintExpression(signal)),
  );
  if (input.refs.length === 0) violations.push({ field: "refs", index: null, rule: "NO_REFS" });
  return violations;
}
