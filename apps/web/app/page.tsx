import { LinkButton } from "@/components/ui";
import { isDemoModeEnabled } from "@/lib/demo/service";

// 데모 모드 링크는 배포 환경변수를 요청 시점에 읽는다
export const dynamic = "force-dynamic";

const STAGES = [
  "저장소 확인",
  "실행 준비",
  "요구사항 검증",
  "테스트 실효성",
  "리뷰 작성",
  "맥락 연결",
];

const FEATURES = [
  {
    label: "요구사항 검증",
    title: "직접 실행해서 판정합니다",
    body: "같은 주문을 두 번 보내면 재고가 2→1→0이 되는지 실제로 요청을 보내 확인합니다. 감점마다 기대값과 실제값, 요청 순서, 코드 위치를 그대로 재생합니다.",
  },
  {
    label: "테스트 실효성",
    title: "테스트가 결함을 잡는지 봅니다",
    body: "구현에 있는 보호 로직을 일부러 제거한 뒤에도 제출된 테스트가 통과하는지 실험합니다. 테스트가 많은지가 아니라 실제로 결함을 잡는지를 봅니다.",
  },
  {
    label: "맥락 연결",
    title: "면접에서 물을 질문까지",
    body: "이력서의 주장과 채점 근거를 연결해 후속 질문을 만듭니다. 확정되지 않은 판정은 점수에 넣지 않고 사람의 검토로 넘깁니다.",
  },
];

export default function HomePage() {
  const demo = isDemoModeEnabled();
  return (
    <main className="bg-surface text-ink">
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-16 pb-14 sm:px-6 sm:pt-24 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-6">
          <p className="w-fit rounded-full bg-primary/8 px-3 py-1 text-sm font-semibold text-primary">
            채용 과제 채점 워크벤치
          </p>
          <h1 className="text-[34px] leading-[1.3] font-bold tracking-tight sm:text-[52px]">
            테스트가 통과했다고
            <br />
            요구사항을 지킨 건 아닙니다
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-neutral-600">
            과제 저장소를 격리된 환경에서 실제로 실행해 요구사항마다 통과와 실패를 판정합니다. 모든
            감점에는 고정된 커밋과 코드 위치, 재현 기록이 붙습니다.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {demo ? (
              <LinkButton href="/demo" variant="primary" size="lg">
                샘플 채점 결과 보기
              </LinkButton>
            ) : null}
            <LinkButton href="/submissions/new" variant={demo ? "secondary" : "primary"} size="lg">
              내 과제 저장소 채점하기
            </LinkButton>
          </div>
          {demo ? (
            <p className="text-sm text-neutral-500">
              샘플은 준비된 공개 저장소 4개이며, 결과와 숫자는 모두 실제 실행에서 나왔습니다.
            </p>
          ) : null}
        </div>
        <ResultPreview />
      </section>

      <section className="border-y border-neutral-200 bg-neutral-50">
        <ol className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-2 px-4 py-5 text-sm sm:px-6">
          {STAGES.map((stage, index) => (
            <li key={stage} className="flex items-center gap-2 font-medium text-neutral-700">
              <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] font-bold text-surface">
                {index + 1}
              </span>
              {stage}
              {index < STAGES.length - 1 ? (
                <span aria-hidden="true" className="text-neutral-300">
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-14 sm:px-6 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <article
            key={feature.label}
            className="flex flex-col gap-2.5 rounded-xl border border-neutral-200 p-6 transition-shadow hover:shadow-[0_4px_16px_rgba(23,23,25,0.08)]"
          >
            <p className="text-[13px] font-semibold text-primary">{feature.label}</p>
            <h2 className="text-xl font-bold tracking-tight">{feature.title}</h2>
            <p className="text-[15px] leading-relaxed text-neutral-600">{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="flex flex-col gap-4 rounded-xl bg-ink p-6 text-surface sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div className="flex flex-col gap-1">
            <p className="text-xl font-bold">점수는 범위로, 미확정은 검토 대기로</p>
            <p className="text-sm text-neutral-300">
              확정된 판정만 점수에 넣고, 판단하지 못한 항목은 따로 표시해 사람이 마무리합니다.
            </p>
          </div>
          <a
            href={demo ? "/demo" : "/assignments"}
            className="inline-flex h-12 shrink-0 items-center justify-center rounded-lg bg-surface px-6 font-semibold text-ink hover:bg-neutral-100"
          >
            {demo ? "워크벤치 살펴보기" : "과제 목록 보기"}
          </a>
        </div>
      </section>
    </main>
  );
}

/**
 * 히어로 오른쪽 미리보기. 샘플 C(결함 구현)를 저장된 실행으로 채점했을 때 워크벤치에 나오는 판정을 옮긴 것이다.
 * 숫자는 저장된 실행과 같은 값이며 화면 소개용이다.
 */
function ResultPreview() {
  const rows = [
    { key: "p1Seed.stock", expected: "2", actual: "2", fail: false },
    { key: "p1AfterFirst.stock", expected: "1", actual: "1", fail: false },
    { key: "p1After.stock", expected: "1", actual: "0", fail: true },
    { key: "second.body.id == first.body.id", expected: "true", actual: "false", fail: true },
  ];
  return (
    <figure
      aria-label="샘플 C 채점 결과 미리보기"
      className="hidden flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 shadow-[0_8px_32px_rgba(23,23,25,0.08)] lg:flex"
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-neutral-500">샘플 C · 결함 구현</span>
        <span className="rounded-md bg-pending/10 px-2 py-0.5 text-xs font-semibold text-pending">
          15점 검토 대기
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[32px] font-bold tracking-tight">54~69</span>
        <span className="text-neutral-500">/ 100</span>
      </div>
      <div className="rounded-lg border border-fail/30 bg-fail/5 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-bold">R-05 멱등 재전송</span>
          <span className="rounded-md bg-fail px-2 py-0.5 text-xs font-semibold text-surface">
            실패 · 0/14
          </span>
        </div>
        <p className="mt-1 text-[13px] text-neutral-600">
          같은 Idempotency-Key로 다시 보낸 주문에서 재고가 한 번 더 차감됩니다.
        </p>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="pb-2 font-medium">검사</th>
            <th className="pb-2 font-medium">기대</th>
            <th className="pb-2 font-medium">실제</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="py-2 pr-2 font-mono text-[12px] text-neutral-700">{row.key}</td>
              <td className="py-2 font-mono">{row.expected}</td>
              <td className={`py-2 font-mono ${row.fail ? "font-bold text-fail" : ""}`}>
                {row.actual}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption className="text-xs text-neutral-500">
        저장된 실행에서 가져온 판정입니다.
      </figcaption>
    </figure>
  );
}
