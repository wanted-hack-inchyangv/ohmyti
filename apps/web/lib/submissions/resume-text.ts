/**
 * 이력서 텍스트 표시용 상수 (T-501). 클라이언트 컴포넌트가 가져오므로 DB·스토어 모듈을 import하지 않는다.
 */
import type { ResumeTextStatus } from "@ohmyti/core";

/** 직접 입력 텍스트 상한 (글자). 추출 텍스트 상한(`@ohmyti/context` maxTextChars)과 같다 */
export const MAX_MANUAL_RESUME_CHARS = 100_000;

export const RESUME_TEXT_STATUS_LABEL: Record<ResumeTextStatus, string> = {
  NONE: "텍스트 없음",
  EXTRACTED: "텍스트 추출됨",
  IMAGE_ONLY: "이미지 문서 (텍스트 없음)",
  MANUAL: "직접 입력한 텍스트",
};

export const IMAGE_ONLY_NOTICE = "텍스트를 추출할 수 없습니다. 텍스트를 직접 입력하세요";
