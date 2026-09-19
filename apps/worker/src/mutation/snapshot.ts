/**
 * 변형 스냅샷 (TICKET.md T-403). 원본 스냅샷의 파일 위에 변형 파일만 덮어쓴 tar.gz를 만든다.
 *
 * 러너는 스냅샷 아티팩트만 받으므로(`prepare`) 변형도 같은 형식의 아티팩트로 넘긴다. 러너 종류(local·vercel)와 무관하게
 * 같은 검증(`unpackSnapshot`)을 거치고, 원격 환경의 작업 디렉터리를 워커가 직접 고칠 필요가 없다.
 * 임시 디렉터리는 끝나면 항상 지운다.
 */
import { assertSafeRelativePath } from "@ohmyti/analysis";
import { packDirectoryToTarGz } from "@ohmyti/runner";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 임시 디렉터리 이름 접두사. 정리 검사(테스트)가 이 이름으로 남은 디렉터리를 찾는다 */
export const MUTANT_SNAPSHOT_TEMP_PREFIX = "ohmyti-mutant-";

export async function buildMutantSnapshot(input: {
  /** 원본 스냅샷 파일 (`readSnapshotEntries`, `node_modules`·`.git` 제외) */
  entries: ReadonlyMap<string, Buffer>;
  /** 변형 후 파일 텍스트 (적용기 `mutatedFiles`) */
  mutatedFiles: Readonly<Record<string, string>>;
  workRoot?: string | undefined;
}): Promise<Uint8Array> {
  const root = input.workRoot ?? os.tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, MUTANT_SNAPSHOT_TEMP_PREFIX));
  try {
    const files = new Map<string, Buffer>(input.entries);
    for (const [relative, text] of Object.entries(input.mutatedFiles)) {
      if (!files.has(relative)) {
        throw new Error(`변형 파일 ${relative}이(가) 원본 스냅샷에 없습니다`);
      }
      files.set(relative, Buffer.from(text, "utf8"));
    }
    for (const [relative, body] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      assertSafeRelativePath(relative);
      const target = path.join(dir, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    return await packDirectoryToTarGz(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
