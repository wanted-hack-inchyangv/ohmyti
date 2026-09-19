import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IMAGE_ONLY_NOTICE } from "@/lib/submissions/resume-text";
import type { ResumeTextView } from "@/lib/submissions/service";
import { ResumeTextPanel } from "./resume-text-panel";

const ID = "00000000-0000-4000-8000-000000000001";

function render(view: ResumeTextView): string {
  return renderToStaticMarkup(<ResumeTextPanel submissionId={ID} initial={view} />);
}

describe("ResumeTextPanel (T-501)", () => {
  it("IMAGE_ONLY면 안내 문구·사유와 입력란이 보인다", () => {
    const html = render({
      status: "IMAGE_ONLY",
      reason:
        "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다 (스캔·이미지 문서). OCR은 하지 않습니다",
      chars: null,
      manualInputAllowed: true,
    });
    expect(IMAGE_ONLY_NOTICE).toBe("텍스트를 추출할 수 없습니다. 텍스트를 직접 입력하세요");
    expect(html).toContain('data-status="IMAGE_ONLY"');
    expect(html).toContain(IMAGE_ONLY_NOTICE);
    expect(html).toContain("RESUME_TEXT_NOT_FOUND:");
    expect(html).toContain('data-testid="manual-resume-text"');
    expect(html).toMatch(/<textarea[^>]*maxLength="100000"/);
    expect(html).toContain("OCR로 읽지 않습니다");
  });

  it("상한 초과(NONE + 사유)도 같은 안내와 입력란을 보여 준다", () => {
    const html = render({
      status: "NONE",
      reason: "RESUME_TOO_MANY_PAGES: 이력서가 20쪽을 넘어 추출하지 않았습니다 (21쪽)",
      chars: null,
      manualInputAllowed: true,
    });
    expect(html).toContain(IMAGE_ONLY_NOTICE);
    expect(html).toContain("RESUME_TOO_MANY_PAGES");
    expect(html).toContain("<textarea");
  });

  it("EXTRACTED면 글자 수만 보이고 안내·입력란이 없다", () => {
    const html = render({
      status: "EXTRACTED",
      reason: null,
      chars: 1234,
      manualInputAllowed: false,
    });
    expect(html).toContain("텍스트 추출됨");
    expect(html).toContain("1,234자");
    expect(html).not.toContain(IMAGE_ONLY_NOTICE);
    expect(html).not.toContain("<textarea");
  });

  it("추출 전(NONE, 사유 없음)이면 입력란이 없다", () => {
    const html = render({ status: "NONE", reason: null, chars: null, manualInputAllowed: false });
    expect(html).toContain("텍스트 없음");
    expect(html).not.toContain("<textarea");
  });

  it("MANUAL이면 안내 없이 다시 입력란만 보인다", () => {
    const html = render({ status: "MANUAL", reason: null, chars: 20, manualInputAllowed: true });
    expect(html).toContain("직접 입력한 텍스트");
    expect(html).toContain("텍스트 다시 입력");
    expect(html).not.toContain(IMAGE_ONLY_NOTICE);
  });
});
