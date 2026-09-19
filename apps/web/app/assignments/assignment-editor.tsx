"use client";

/**
 * 과제 설정 편집기 (T-406, PRD 6장 ①). 왼쪽: 명세 마크다운·실행 계약. 오른쪽: 요구사항·배점 표와 AI 초안.
 * `/assignments/new`(새 과제 + 첫 DRAFT 버전)와 DRAFT 버전 화면이 같은 컴포넌트를 쓴다. 승인·검증 중인 버전은
 * 이 컴포넌트를 그리지 않는다 (편집 컨트롤 없음).
 *
 * - `AI 초안 생성`: 명세로 `rubric_drafts` 요청을 넣고 상태를 폴링한다. 성공하면 표를 채우고 `AI 초안 · 미승인` 배지를 붙인다.
 *   초안이 `validateRubric()`을 통과하지 못하면 표는 채우되 오류 목록을 함께 보여 준다.
 * - 저장: 같은 규칙(`editorToRubric`·`formToContract`)으로 브라우저에서 먼저 검사해 오류를 보여 준다. 형식 오류(숫자·JSON)만
 *   전송을 막고, 기준 규칙(`validateRubric()`) 위반은 서버가 다시 판정해 거부한다 (서버가 최종 판단).
 */
import { RUBRIC_DRAFT_BADGE, RUBRIC_TOTAL_POINTS, type RubricDraftView } from "@ohmyti/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  getRubricDraftAction,
  requestRubricDraftAction,
  saveDraftVersionAction,
  saveNewAssignmentAction,
} from "@/lib/assignments/actions";
import {
  AREAS,
  AREA_LABEL,
  CONTRACT_FIELD_LABEL,
  METHODS,
  METHOD_LABEL,
  editorToRubric,
  emptyRow,
  formToContract,
  formatExtras,
  rubricToExtras,
  rubricToRows,
  totalPoints,
  type ContractForm,
  type CriterionRow,
  type EditorIssue,
} from "@/lib/assignments/editor";
import { Badge, Button, inputClassName } from "@/components/ui";
import { IssueList, SpecPreview } from "./setup-views";

export interface AssignmentEditorInitial {
  name: string;
  description: string;
  title: string;
  specMarkdown: string;
  contract: ContractForm;
  rows: CriterionRow[];
  extrasJson: string;
  harnessVersion: string;
}

export type AssignmentEditorProps =
  | { mode: "new"; initial: AssignmentEditorInitial; harnessVersions: string[] }
  | {
      mode: "draft";
      initial: AssignmentEditorInitial;
      assignmentId: string;
      assignmentVersionId: string;
    };

const DRAFT_POLL_MS = 1_500;

type DraftState =
  | { phase: "idle" }
  | { phase: "waiting"; draftId: string }
  | { phase: "failed"; message: string }
  | { phase: "applied"; view: RubricDraftView };

const cardClass =
  "flex min-w-0 flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6";
const cardTitleClass = "text-lg font-bold tracking-tight";
const fieldClass = "flex flex-col gap-2";
const labelClass = "text-sm font-semibold text-neutral-800";
const contractRowClass =
  "grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-3";
/** 코드·경로 값 입력 (계약·하네스) */
const monoInputClass = inputClassName.replace("text-[15px]", "font-mono text-sm");
/** 여러 줄 입력: 공통 입력 모양에서 고정 높이만 뺀다 */
const textareaClass = inputClassName.replace("h-12 ", "") + " py-3 leading-relaxed";
/** 기준 표 칸 입력: 공통 입력보다 낮고 좁다 */
const cellInputClass = inputClassName
  .replace("h-12", "h-10")
  .replace("px-4 text-[15px]", "px-3 text-sm");

export function AssignmentEditor(props: AssignmentEditorProps) {
  const router = useRouter();
  const { initial } = props;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [title, setTitle] = useState(initial.title);
  const [spec, setSpec] = useState(initial.specMarkdown);
  const [specTab, setSpecTab] = useState<"edit" | "preview">("edit");
  const [contract, setContract] = useState<ContractForm>(initial.contract);
  const [rows, setRows] = useState<CriterionRow[]>(initial.rows);
  const [extrasJson, setExtrasJson] = useState(initial.extrasJson);
  const [harnessVersion, setHarnessVersion] = useState(initial.harnessVersion);
  const [draft, setDraft] = useState<DraftState>({ phase: "idle" });
  const [serverIssues, setServerIssues] = useState<EditorIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const rubricResult = useMemo(() => editorToRubric(rows, extrasJson), [rows, extrasJson]);
  const contractResult = useMemo(() => formToContract(contract), [contract]);
  const localIssues: EditorIssue[] = [
    ...rubricResult.issues,
    ...(contractResult.ok ? [] : contractResult.issues),
  ];
  const total = totalPoints(rows);

  // AI 초안 폴링: 끝날 때까지 상태를 읽고, 성공하면 표를 채운다
  useEffect(() => {
    if (draft.phase !== "waiting") return;
    let cancelled = false;
    const tick = async () => {
      const result = await getRubricDraftAction(draft.draftId).catch((error: unknown) => ({
        ok: false as const,
        code: "INTERNAL" as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (cancelled) return;
      if (!result.ok) {
        setDraft({ phase: "failed", message: result.message });
        return;
      }
      const view = result.data;
      if (view.status === "FAILED") {
        setDraft({
          phase: "failed",
          message: `${view.failure?.code ?? "FAILED"}: ${view.failure?.message ?? "초안을 만들지 못했습니다"}`,
        });
      } else if (view.status === "SUCCEEDED" && view.rubric) {
        setRows(rubricToRows(view.rubric));
        setExtrasJson(formatExtras(rubricToExtras(view.rubric)));
        setDraft({ phase: "applied", view });
      }
    };
    const timer = setInterval(() => void tick(), DRAFT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [draft]);

  function requestDraft() {
    setMessage(null);
    startTransition(async () => {
      const result = await requestRubricDraftAction({
        specMarkdown: spec,
        ...(props.mode === "draft" ? { assignmentId: props.assignmentId } : {}),
      });
      setDraft(
        result.ok
          ? { phase: "waiting", draftId: result.data.draftId }
          : { phase: "failed", message: result.message },
      );
    });
  }

  function save() {
    setMessage(null);
    setServerIssues([]);
    // 형식 오류가 있으면 보내지 않는다. 기준 규칙 위반(validateRubric)은 서버가 같은 함수로 다시 판정해 거부한다
    if (!rubricResult.ok || !contractResult.ok) return;
    const rubric = rubricResult.rubric;
    const executionContract = contractResult.contract;
    startTransition(async () => {
      if (props.mode === "new") {
        const result = await saveNewAssignmentAction({
          name,
          ...(description.trim() ? { description } : {}),
          title,
          specMarkdown: spec,
          executionContract,
          rubric,
          harnessVersion,
        });
        if (!result.ok) {
          setServerIssues(issuesFromAction(result));
          return;
        }
        router.push(
          `/assignments/${result.data.assignment.id}/versions/${result.data.version.version}`,
        );
        return;
      }
      const result = await saveDraftVersionAction({
        assignmentVersionId: props.assignmentVersionId,
        title,
        specMarkdown: spec,
        executionContract,
        rubric,
      });
      if (!result.ok) {
        setServerIssues(issuesFromAction(result));
        return;
      }
      setMessage(
        `저장했습니다 (${result.data.rubricVersion}). 기준이 바뀌었으면 검증을 다시 실행하세요.`,
      );
      router.refresh();
    });
  }

  function updateRow(index: number, patch: Partial<CriterionRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const draftView = draft.phase === "applied" ? draft.view : null;
  const saveBlocked = !rubricResult.ok || !contractResult.ok || pending;

  return (
    <div className="flex flex-col gap-6" data-testid="assignment-editor" data-mode={props.mode}>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col gap-4" aria-label="명세와 실행 계약">
          <div className={cardClass}>
            <h2 className={cardTitleClass}>기본 정보</h2>
            {props.mode === "new" ? (
              <>
                <label className={fieldClass}>
                  <span className={labelClass}>과제 이름</span>
                  <input
                    className={inputClassName}
                    name="name"
                    placeholder="예: 주문·재고 API"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className={fieldClass}>
                  <span className={labelClass}>
                    설명 <span className="font-normal text-neutral-400">(선택)</span>
                  </span>
                  <input
                    className={inputClassName}
                    name="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <label className={fieldClass}>
              <span className={labelClass}>버전 제목</span>
              <input
                className={inputClassName}
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          </div>

          <div className={cardClass}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={cardTitleClass}>
                과제 명세 <span className="text-sm font-medium text-neutral-400">마크다운</span>
              </h2>
              <div className="flex gap-1 rounded-lg bg-neutral-100 p-1 text-[13px]" role="tablist">
                {(["edit", "preview"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={specTab === tab}
                    className={`h-8 rounded-md px-3 font-semibold transition-colors ${specTab === tab ? "bg-surface text-ink shadow-sm" : "text-neutral-500 hover:text-ink"}`}
                    onClick={() => setSpecTab(tab)}
                  >
                    {tab === "edit" ? "편집" : "미리보기"}
                  </button>
                ))}
              </div>
            </div>
            {specTab === "edit" ? (
              <textarea
                className={`${textareaClass} min-h-80 font-mono text-[13px]`}
                name="specMarkdown"
                aria-label="과제 명세"
                placeholder="# 과제 제목&#10;- 요구사항을 마크다운으로 적습니다"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
              />
            ) : (
              <div className="min-h-80 rounded-lg border border-neutral-200 p-4">
                <SpecPreview text={spec} />
              </div>
            )}
          </div>

          <fieldset className={cardClass}>
            <legend className="sr-only">실행 계약</legend>
            <h2 className={cardTitleClass} aria-hidden="true">
              실행 계약
            </h2>
            {(Object.keys(CONTRACT_FIELD_LABEL) as Array<keyof ContractForm>).map((key) => (
              <label key={key} className={contractRowClass}>
                <span className="text-sm font-medium text-neutral-600">
                  {CONTRACT_FIELD_LABEL[key]}
                </span>
                <input
                  className={monoInputClass}
                  name={`contract.${key}`}
                  value={contract[key]}
                  onChange={(e) => setContract((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </label>
            ))}
            {props.mode === "new" ? (
              <label className={contractRowClass}>
                <span className="text-sm font-medium text-neutral-600">하네스 버전</span>
                {props.harnessVersions.length > 0 ? (
                  <select
                    className={monoInputClass}
                    name="harnessVersion"
                    value={harnessVersion}
                    onChange={(e) => setHarnessVersion(e.target.value)}
                  >
                    {props.harnessVersions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={monoInputClass}
                    name="harnessVersion"
                    value={harnessVersion}
                    onChange={(e) => setHarnessVersion(e.target.value)}
                  />
                )}
              </label>
            ) : null}
          </fieldset>
        </section>

        <section className={`${cardClass} gap-5`} aria-label="요구사항과 배점">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className={cardTitleClass}>요구사항·배점</h2>
            {draftView ? (
              <Badge tone="pending" data-testid="ai-draft-badge">
                {RUBRIC_DRAFT_BADGE}
              </Badge>
            ) : null}
            <span
              className={`ml-auto rounded-full px-3 py-1 text-sm font-bold tabular-nums ${total === RUBRIC_TOTAL_POINTS ? "bg-neutral-100 text-ink" : "bg-fail/10 text-fail"}`}
              data-testid="points-total"
            >
              합계 {total}/{RUBRIC_TOTAL_POINTS}
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={requestDraft}
              disabled={pending || draft.phase === "waiting" || !spec.trim()}
              title={spec.trim() ? undefined : "명세를 먼저 입력하세요"}
            >
              AI 초안 생성
            </Button>
          </div>

          {draft.phase === "waiting" ? (
            <p
              className="rounded-lg bg-primary/5 px-4 py-3 text-sm text-neutral-800"
              role="status"
              data-testid="ai-draft-status"
            >
              AI 초안을 만드는 중입니다. 워커가 명세를 읽고 기준을 제안하면 표가 채워집니다.
            </p>
          ) : null}
          {draft.phase === "failed" ? (
            <p
              className="rounded-lg bg-fail/5 px-4 py-3 text-sm text-neutral-800 ring-1 ring-fail/20"
              role="alert"
              data-testid="ai-draft-error"
            >
              AI 초안을 만들지 못했습니다: {draft.message}. 표를 직접 채우거나 다시 시도하세요.
            </p>
          ) : null}
          {draftView ? (
            <div
              className="flex flex-col gap-1.5 rounded-lg bg-pending/5 px-4 py-3 text-sm leading-relaxed text-neutral-700 ring-1 ring-pending/20"
              data-testid="ai-draft-info"
              data-draft-valid={draftView.validationErrors.length === 0 ? "true" : "false"}
            >
              <p>
                AI가 제안한 초안입니다. 사람이 고치고 저장·검증·승인하기 전에는 채점에 쓰이지
                않습니다.
                {draftView.model ? ` 모델 ${draftView.model}` : ""}
                {draftView.promptVersion ? ` · 프롬프트 ${draftView.promptVersion}` : ""}
              </p>
              <p className="font-semibold text-ink">
                {draftView.validationErrors.length === 0
                  ? "초안이 validateRubric()을 통과했습니다."
                  : `초안이 validateRubric()을 통과하지 못했습니다 (오류 ${draftView.validationErrors.length}건). 아래 오류를 고친 뒤 저장하세요.`}
              </p>
              {draftView.notes.length > 0 ? (
                <ul className="list-disc pl-5">
                  {draftView.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {draftView.droppedMutationIds.length > 0 ? (
                <p>
                  카탈로그에 없는 결함 주입 ID를 뺐습니다: {draftView.droppedMutationIds.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 기준 한 줄을 카드 한 장으로 그린다. 표 의미(tbody tr)는 유지하고 모양만 격자로 바꾼다 */}
          <table className="block w-full text-sm" data-testid="rubric-editor">
            <thead className="sr-only">
              <tr>
                <th>ID</th>
                <th>영역</th>
                <th>요구사항</th>
                <th>배점</th>
                <th>방법</th>
                <th>그룹</th>
                <th>판정 조건</th>
                <th>부분</th>
                <th>삭제</th>
              </tr>
            </thead>
            <tbody className="flex flex-col gap-3">
              {rows.map((row, index) => (
                <tr
                  key={index}
                  className="grid grid-cols-12 gap-x-3 gap-y-3 rounded-xl border border-neutral-200 bg-surface p-4"
                  data-row={row.id}
                >
                  <td className="col-span-4 sm:col-span-2">
                    <CellLabel>ID</CellLabel>
                    <input
                      className={`${cellInputClass} font-mono`}
                      aria-label={`${index + 1}행 ID`}
                      value={row.id}
                      onChange={(e) => updateRow(index, { id: e.target.value })}
                    />
                  </td>
                  <td className="col-span-8 sm:col-span-3">
                    <CellLabel>영역</CellLabel>
                    <select
                      className={cellInputClass}
                      aria-label={`${index + 1}행 영역`}
                      value={row.area}
                      onChange={(e) =>
                        updateRow(index, { area: e.target.value as CriterionRow["area"] })
                      }
                    >
                      {AREAS.map((a) => (
                        <option key={a} value={a}>
                          {AREA_LABEL[a]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="col-span-12 sm:col-span-5">
                    <CellLabel>요구사항</CellLabel>
                    <input
                      className={`${cellInputClass} font-semibold`}
                      aria-label={`${index + 1}행 요구사항`}
                      value={row.title}
                      onChange={(e) => updateRow(index, { title: e.target.value })}
                    />
                  </td>
                  <td className="col-span-4 sm:col-span-2">
                    <CellLabel>배점</CellLabel>
                    <input
                      className={`${cellInputClass} text-right font-semibold tabular-nums`}
                      aria-label={`${index + 1}행 배점`}
                      inputMode="numeric"
                      value={row.maxPoints}
                      onChange={(e) => updateRow(index, { maxPoints: e.target.value })}
                    />
                  </td>
                  <td className="col-span-8 sm:col-span-4">
                    <CellLabel>방법</CellLabel>
                    <select
                      className={cellInputClass}
                      aria-label={`${index + 1}행 방법`}
                      value={row.method}
                      onChange={(e) =>
                        updateRow(index, { method: e.target.value as CriterionRow["method"] })
                      }
                    >
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="col-span-4 sm:col-span-2">
                    <CellLabel>그룹</CellLabel>
                    <input
                      className={`${cellInputClass} font-mono`}
                      aria-label={`${index + 1}행 그룹`}
                      value={row.groupId}
                      onChange={(e) => updateRow(index, { groupId: e.target.value })}
                    />
                  </td>
                  <td className="order-last col-span-12">
                    <CellLabel>판정 조건</CellLabel>
                    <textarea
                      className={`${textareaClass} min-h-20 text-sm`}
                      aria-label={`${index + 1}행 판정 조건`}
                      value={row.condition}
                      onChange={(e) => updateRow(index, { condition: e.target.value })}
                    />
                  </td>
                  <td className="col-span-5 flex items-end sm:col-span-3">
                    <label className="flex h-10 items-center gap-2 text-sm font-medium text-neutral-700">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        aria-label={`${index + 1}행 부분 점수 허용`}
                        checked={row.allowPartial}
                        onChange={(e) => updateRow(index, { allowPartial: e.target.checked })}
                      />
                      <span aria-hidden="true">부분 점수</span>
                    </label>
                  </td>
                  <td className="col-span-3 flex items-end justify-end sm:col-span-3">
                    <button
                      type="button"
                      className="h-10 rounded-lg px-3 text-sm font-semibold text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-ink"
                      aria-label={`${index + 1}행 삭제`}
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? (
            <p className="rounded-lg bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-500">
              기준이 없습니다. AI 초안을 생성하거나 행을 추가하세요.
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            onClick={() => setRows((prev) => [...prev, emptyRow(prev.length)])}
          >
            + 행 추가
          </Button>

          <label className={fieldClass}>
            <span className={labelClass}>추가 규칙 (JSON)</span>
            <span className="text-[13px] leading-relaxed text-neutral-500">
              그룹(groups)·부분 점수 하위 기준(partialRules)·독립 감점 사유(independentReasons)·정적
              검사(staticChecks)
            </span>
            <textarea
              className={`${textareaClass} min-h-40 font-mono text-[13px]`}
              aria-label="추가 규칙 JSON"
              value={extrasJson}
              onChange={(e) => setExtrasJson(e.target.value)}
            />
          </label>
        </section>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6">
        {localIssues.length === 0 ? (
          <p className="text-sm font-semibold text-ink" data-testid="rubric-valid">
            <span aria-hidden="true">✓ </span>기준이 validateRubric() 규칙을 통과합니다.
          </p>
        ) : (
          <IssueList issues={localIssues} title="저장하기 전에 고쳐야 할 점" />
        )}
        <IssueList issues={serverIssues} title="서버가 저장을 거부했습니다" />
        {message ? (
          <p
            className="rounded-lg bg-primary/5 px-4 py-3 text-sm text-neutral-800"
            role="status"
            data-testid="save-message"
          >
            {message}
          </p>
        ) : null}
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="self-start"
          onClick={save}
          disabled={saveBlocked}
        >
          {props.mode === "new" ? "과제 저장" : "초안 저장"}
        </Button>
      </div>
    </div>
  );
}

function CellLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="mb-1 block text-[13px] font-medium text-neutral-500">
      {children}
    </span>
  );
}

function issuesFromAction(result: {
  code: string;
  message: string;
  details?: unknown;
}): EditorIssue[] {
  if (result.code === "RUBRIC_INVALID" && Array.isArray(result.details)) {
    return (result.details as EditorIssue[]).map((d) => ({
      code: d.code,
      message: d.message,
      ref: d.ref,
    }));
  }
  return [{ code: result.code, message: result.message }];
}
