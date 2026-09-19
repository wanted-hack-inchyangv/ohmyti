/** @ohmyti/storage 오류 계층. 호출자는 `instanceof`로 원인을 구분한다. */

export class ArtifactStoreError extends Error {
  override readonly name: string = "ArtifactStoreError";
}

/** 키 규약 위반: `..`, 절대 경로, 빈 세그먼트, 허용되지 않은 문자 */
export class InvalidArtifactKeyError extends ArtifactStoreError {
  override readonly name = "InvalidArtifactKeyError";
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`잘못된 아티팩트 키 ${JSON.stringify(key)}: ${reason}`);
  }
}

/** 객체 크기가 상한을 넘었다 */
export class ArtifactTooLargeError extends ArtifactStoreError {
  override readonly name = "ArtifactTooLargeError";
  constructor(
    readonly key: string,
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`아티팩트 ${key}의 크기 ${size}바이트가 상한 ${maxBytes}바이트를 넘습니다`);
  }
}

/** contentType이 비어 있거나 `type/subtype` 형식이 아니다 */
export class InvalidContentTypeError extends ArtifactStoreError {
  override readonly name = "InvalidContentTypeError";
  constructor(readonly contentType: string) {
    super(`잘못된 contentType ${JSON.stringify(contentType)}: "type/subtype" 형식이어야 합니다`);
  }
}

/** `createArtifactStore(env)`에 필요한 환경변수가 없거나 값이 잘못됐다 */
export class ArtifactStoreConfigError extends ArtifactStoreError {
  override readonly name = "ArtifactStoreConfigError";
}
