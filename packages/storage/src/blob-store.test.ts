/**
 * Vercel Blob 통합 테스트. `BLOB_READ_WRITE_TOKEN`이 없으면 skip으로 표시된다.
 * 실제 스토어의 `submissions/t<hex>-a`, `submissions/t<hex>-b`, `evaluations/t<hex>-e` 접두사 아래에 쓰고 끝나면 지운다.
 */
import { describe } from "vitest";
import { BlobArtifactStore } from "./blob-store";
import { describeArtifactStoreContract } from "./contract-suite";

const token = process.env.BLOB_READ_WRITE_TOKEN;
const access = process.env.BLOB_ACCESS === "public" ? "public" : "private";

if (!token) {
  console.warn("[@ohmyti/storage] BLOB_READ_WRITE_TOKEN이 없어 Blob 계약 테스트를 건너뜁니다");
  describe.skip("BlobArtifactStore ArtifactStore 계약", () => {});
} else {
  describeArtifactStoreContract("BlobArtifactStore", {
    create: ({ maxBytes }) => new BlobArtifactStore({ token, access, maxBytes }),
    settleMs: 15_000,
    testTimeoutMs: 60_000,
  });
}
