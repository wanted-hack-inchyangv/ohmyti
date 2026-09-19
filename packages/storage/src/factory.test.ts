import { describe, expect, it } from "vitest";
import { BlobArtifactStore } from "./blob-store";
import { ArtifactStoreConfigError } from "./errors";
import { createArtifactStore } from "./factory";
import { FsArtifactStore } from "./fs-store";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./store";

describe("createArtifactStore", () => {
  it("기본값은 fs이며 ARTIFACT_FS_ROOT를 쓴다", () => {
    const store = createArtifactStore({ ARTIFACT_FS_ROOT: "/tmp/ohmyti-x" });
    expect(store).toBeInstanceOf(FsArtifactStore);
    expect(store.kind).toBe("fs");
    expect((store as FsArtifactStore).root).toBe("/tmp/ohmyti-x");
    expect(store.maxBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES);
  });

  it("ARTIFACT_MAX_BYTES로 상한을 바꾼다", () => {
    expect(createArtifactStore({ ARTIFACT_MAX_BYTES: "1024" }).maxBytes).toBe(1024);
    expect(() => createArtifactStore({ ARTIFACT_MAX_BYTES: "0" })).toThrow(
      ArtifactStoreConfigError,
    );
    expect(() => createArtifactStore({ ARTIFACT_MAX_BYTES: "abc" })).toThrow(
      ArtifactStoreConfigError,
    );
  });

  it("blob은 토큰이 필요하고 기본 접근 수준은 private", () => {
    expect(() => createArtifactStore({ ARTIFACT_STORE: "blob" })).toThrow(ArtifactStoreConfigError);
    const store = createArtifactStore({
      ARTIFACT_STORE: "blob",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
    });
    expect(store).toBeInstanceOf(BlobArtifactStore);
    expect((store as BlobArtifactStore).access).toBe("private");
    expect(
      (
        createArtifactStore({
          ARTIFACT_STORE: "blob",
          BLOB_READ_WRITE_TOKEN: "t",
          BLOB_ACCESS: "public",
        }) as BlobArtifactStore
      ).access,
    ).toBe("public");
    expect(() =>
      createArtifactStore({ ARTIFACT_STORE: "blob", BLOB_READ_WRITE_TOKEN: "t", BLOB_ACCESS: "x" }),
    ).toThrow(ArtifactStoreConfigError);
  });

  it("알 수 없는 종류는 거부한다", () => {
    expect(() => createArtifactStore({ ARTIFACT_STORE: "s3" })).toThrow(ArtifactStoreConfigError);
  });
});
