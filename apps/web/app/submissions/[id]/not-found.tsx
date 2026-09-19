import { headers } from "next/headers";
import { LinkButton } from "@/components/ui";
import { getDb } from "@/lib/db";
import { REQUEST_PATHNAME_HEADER, submissionIdFromPath } from "@/lib/request-path";
import {
  formatDeletionTime,
  readDeletionNotice,
  type DeletionNotice,
} from "@/lib/submissions/service";

async function deletionNotice(): Promise<DeletionNotice | null> {
  const id = submissionIdFromPath((await headers()).get(REQUEST_PATHNAME_HEADER));
  if (!id) return null;
  try {
    return await readDeletionNotice({ db: getDb().db }, id);
  } catch {
    return null;
  }
}

/** 없는 제출과 삭제된 제출(T-506) 모두 404다. 삭제된 제출이면 "삭제됨"과 시각을 보인다 */
export default async function SubmissionNotFound() {
  const deletion = await deletionNotice();
  if (deletion) {
    return (
      <main
        className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 pt-20 pb-24 text-center sm:px-6 sm:pt-28"
        data-testid="submission-deleted"
        data-state={deletion.state}
      >
        <span
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 text-2xl font-bold text-neutral-400"
        >
          ×
        </span>
        <h1 className="text-2xl font-bold tracking-tight">삭제된 제출입니다</h1>
        <p className="text-[15px] leading-relaxed text-neutral-600">
          {deletion.state === "DONE"
            ? `${formatDeletionTime(deletion.at)}에 저장소 사본, 이력서, 채점 결과, 재현 자료를 모두 지웠습니다.`
            : `${formatDeletionTime(deletion.at)}에 삭제를 요청했습니다. 진행 중인 채점을 취소했고 자료를 지우는 중입니다.`}
        </p>
        <LinkButton href="/submissions/new" variant="primary" size="lg" className="mt-4">
          새 제출 만들기
        </LinkButton>
      </main>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 pt-20 pb-24 text-center sm:px-6 sm:pt-28">
      <span
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 text-2xl font-bold text-neutral-400"
      >
        ?
      </span>
      <h1 className="text-2xl font-bold tracking-tight">제출을 찾을 수 없습니다</h1>
      <p className="text-[15px] leading-relaxed text-neutral-600">
        ID가 잘못되었거나 없는 제출입니다.
      </p>
      <LinkButton href="/submissions/new" variant="primary" size="lg" className="mt-4">
        새 제출 만들기
      </LinkButton>
    </main>
  );
}
