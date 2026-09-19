import { createArtifactStore, type ArtifactStore } from "@ohmyti/storage";

// DB 핸들(lib/db.ts)과 같은 이유로 globalThis에 둔다. 환경변수(ARTIFACT_STORE 등)는 첫 호출에서 읽는다.
const globalForStore = globalThis as typeof globalThis & { __ohmytiArtifactStore?: ArtifactStore };

/** 웹이 쓰는 Artifact Store. 명세 원문·이력서 원본을 넣고 읽는다. 설정 오류는 그대로 던진다 */
export function getArtifactStore(): ArtifactStore {
  if (!globalForStore.__ohmytiArtifactStore) {
    globalForStore.__ohmytiArtifactStore = createArtifactStore(process.env);
  }
  return globalForStore.__ohmytiArtifactStore;
}
