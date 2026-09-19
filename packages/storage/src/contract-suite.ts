/**
 * ArtifactStore 계약 테스트. fs·blob 두 구현이 같은 스위트를 통과해야 한다 (T-005 인수 기준).
 * 테스트 파일에서 `describeArtifactStoreContract(name, factory)`로 호출한다.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactTooLargeError, InvalidArtifactKeyError, InvalidContentTypeError } from "./errors";
import { artifactKeys } from "./keys";
import type { ArtifactStore } from "./store";

export interface ContractSuiteOptions {
  /** 스토어를 만든다. 상한은 `maxBytes`로 고정한다. */
  create: (options: { maxBytes: number }) => Promise<ArtifactStore> | ArtifactStore;
  /** 스위트가 끝난 뒤 정리 */
  destroy?: (store: ArtifactStore) => Promise<void> | void;
  /** 원격 스토어처럼 list가 최종적 일관성을 갖는 경우 재시도 대기 시간(ms) */
  settleMs?: number;
  /** 테스트 하나의 제한 시간(ms). 원격 스토어는 늘린다. */
  testTimeoutMs?: number;
}

export const CONTRACT_MAX_BYTES = 64 * 1024;

export function describeArtifactStoreContract(name: string, options: ContractSuiteOptions): void {
  const timeout = options.testTimeoutMs ?? 5_000;
  describe(`${name} ArtifactStore 계약`, { timeout }, () => {
    let store: ArtifactStore;
    // 실행마다 다른 접두사를 써서 원격 스토어에 남은 객체와 섞이지 않게 한다.
    const runId = `t${randomBytes(4).toString("hex")}`;
    const subA = `${runId}-a`;
    const subB = `${runId}-b`;
    const evalId = `${runId}-e`;
    const createdPrefixes = [
      artifactKeys.submissionPrefix(subA),
      artifactKeys.submissionPrefix(subB),
      artifactKeys.evaluationPrefix(evalId),
    ];

    beforeAll(async () => {
      store = await options.create({ maxBytes: CONTRACT_MAX_BYTES });
    });

    afterAll(async () => {
      for (const prefix of createdPrefixes) await store.deletePrefix(prefix);
      await options.destroy?.(store);
    }, timeout);

    async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
      const deadline = Date.now() + (options.settleMs ?? 0);
      let value = await fn();
      while (!check(value) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        value = await fn();
      }
      return value;
    }

    it("put 후 get으로 같은 바이트와 contentType을 돌려준다", async () => {
      const key = artifactKeys.snapshot(subA);
      const body = randomBytes(1024);
      const meta = await store.put(key, body, { contentType: "application/gzip" });
      expect(meta).toEqual({ key, size: 1024, contentType: "application/gzip" });

      const got = await store.get(key);
      expect(got).not.toBeNull();
      expect(Buffer.from(got!.body).equals(body)).toBe(true);
      expect(got!.contentType).toBe("application/gzip");
      expect(got!.size).toBe(1024);
    });

    it("문자열 본문은 UTF-8로 저장한다", async () => {
      const key = artifactKeys.runRecord(evalId, "run1", "stdout");
      const text = JSON.stringify({ lines: ["한글", "PASS는 신뢰하지 않음"] });
      await store.put(key, text, { contentType: "application/json" });
      const got = await store.get(key);
      expect(Buffer.from(got!.body).toString("utf8")).toBe(text);
      expect(got!.size).toBe(Buffer.byteLength(text, "utf8"));
    });

    it("getStream은 전체 본문을 스트리밍한다", async () => {
      const key = artifactKeys.runRecord(evalId, "run1", "timeline");
      const body = randomBytes(8 * 1024);
      await store.put(key, body, { contentType: "application/json" });
      const found = await store.getStream(key);
      expect(found).not.toBeNull();
      expect(found!.contentType).toBe("application/json");
      const chunks: Buffer[] = [];
      for await (const chunk of found!.stream) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(Buffer.concat(chunks).equals(body)).toBe(true);
    });

    it("같은 키에 put하면 덮어쓴다", async () => {
      const key = artifactKeys.runRecord(evalId, "run1", "actual");
      await store.put(key, "v1", { contentType: "application/json" });
      await store.put(key, "v2-longer", { contentType: "application/json" });
      const got = await eventually(
        () => store.get(key),
        (v) => v !== null && Buffer.from(v.body).toString() === "v2-longer",
      );
      expect(Buffer.from(got!.body).toString()).toBe("v2-longer");
      expect(got!.size).toBe(9);
    });

    it("없는 키는 get·getStream이 null, exists가 false", async () => {
      const key = artifactKeys.runRecord(evalId, "missing", "input");
      expect(await store.get(key)).toBeNull();
      expect(await store.getStream(key)).toBeNull();
      expect(await store.exists(key)).toBe(false);
    });

    it("exists는 저장된 키에 true", async () => {
      const key = artifactKeys.resume(subA);
      await store.put(key, randomBytes(16), { contentType: "application/pdf" });
      expect(await store.exists(key)).toBe(true);
    });

    it("delete는 객체를 지우고, 없는 키에도 성공한다", async () => {
      const key = artifactKeys.mutationDiff(evalId, "m1");
      await store.put(key, "--- a\n+++ b\n", { contentType: "text/x-patch" });
      await store.delete(key);
      const exists = await eventually(
        () => store.exists(key),
        (v) => v === false,
      );
      expect(exists).toBe(false);
      await expect(store.delete(key)).resolves.toBeUndefined();
    });

    it("deletePrefix('submissions/<id>/')는 그 접두사의 모든 객체를 지우고 다른 제출은 건드리지 않는다", async () => {
      const keysB = [
        artifactKeys.snapshot(subB),
        artifactKeys.resume(subB),
        `submissions/${subB}/extra/nested/file.json`,
      ];
      for (const key of keysB) await store.put(key, "x", { contentType: "application/json" });
      const keepA = artifactKeys.snapshot(subA);
      expect(await store.exists(keepA)).toBe(true);

      await eventually(
        async () => Promise.all(keysB.map((k) => store.exists(k))),
        (v) => v.every(Boolean),
      );
      // 원격 스토어의 list는 최종적 일관성을 가지므로, 지운 개수가 채워질 때까지 반복한다.
      let deleted = await store.deletePrefix(artifactKeys.submissionPrefix(subB));
      const deadline = Date.now() + (options.settleMs ?? 0);
      while (deleted < keysB.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        deleted += await store.deletePrefix(artifactKeys.submissionPrefix(subB));
      }
      expect(deleted).toBe(keysB.length);

      for (const key of keysB) {
        const exists = await eventually(
          () => store.exists(key),
          (v) => v === false,
        );
        expect(exists).toBe(false);
      }
      expect(await store.exists(keepA)).toBe(true);
    });

    it("deletePrefix는 없는 접두사에 0을 돌려준다", async () => {
      expect(await store.deletePrefix(`submissions/${runId}-none/`)).toBe(0);
    });

    it("키에 '..', 절대 경로, 빈 세그먼트가 있으면 모든 메서드가 거부한다", async () => {
      const bad = [
        "../etc/passwd",
        "submissions/../x",
        "submissions/a/../../x",
        "/submissions/a/snapshot.tar.gz",
        "submissions//a",
        "submissions/a/",
        "",
        "submissions/a/./b",
        "submissions\\a\\b",
        "submissions/a/b c",
      ];
      for (const key of bad) {
        await expect(store.put(key, "x", { contentType: "text/plain" })).rejects.toBeInstanceOf(
          InvalidArtifactKeyError,
        );
        await expect(store.get(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
        await expect(store.getStream(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
        await expect(store.exists(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
        await expect(store.delete(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      }
      for (const prefix of ["submissions/../", "submissions/a", "/submissions/", "submissions//"]) {
        await expect(store.deletePrefix(prefix)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      }
    });

    it("상한을 넘는 객체는 ArtifactTooLargeError로 거부하고 저장하지 않는다", async () => {
      const key = artifactKeys.runRecord(evalId, "big", "stderr");
      await expect(
        store.put(key, randomBytes(CONTRACT_MAX_BYTES + 1), { contentType: "application/json" }),
      ).rejects.toBeInstanceOf(ArtifactTooLargeError);
      expect(await store.exists(key)).toBe(false);

      // 상한과 같은 크기는 허용한다.
      await store.put(key, randomBytes(CONTRACT_MAX_BYTES), { contentType: "application/json" });
      expect(await store.exists(key)).toBe(true);

      // 호출별 상한은 스토어 상한보다 더 작게만 줄 수 있다.
      await expect(
        store.put(key, randomBytes(200), { contentType: "application/json", maxBytes: 100 }),
      ).rejects.toBeInstanceOf(ArtifactTooLargeError);
      await expect(
        store.put(key, randomBytes(CONTRACT_MAX_BYTES + 1), {
          contentType: "application/json",
          maxBytes: CONTRACT_MAX_BYTES * 10,
        }),
      ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    });

    it("contentType이 없거나 형식이 틀리면 거부한다", async () => {
      const key = artifactKeys.runRecord(evalId, "ct", "input");
      for (const contentType of ["", "json", "application/", "/json"]) {
        await expect(store.put(key, "x", { contentType })).rejects.toBeInstanceOf(
          InvalidContentTypeError,
        );
      }
    });
  });
}
