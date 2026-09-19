# 이력서 PDF 픽스처 (T-501)

| 파일                 | 내용                                                        | 기대 상태    |
| -------------------- | ----------------------------------------------------------- | ------------ |
| `resume-text.pdf`    | 가상 인물의 텍스트 이력서 1쪽 (`sampleResumeLines()`)       | `EXTRACTED`  |
| `resume-scanned.pdf` | 회색 이미지 1장만 있는 1쪽, 텍스트 층 없음 (스캔 문서 모사) | `IMAGE_ONLY` |

두 파일은 `src/testing/pdf.ts`의 빌더 출력과 바이트 단위로 같아야 한다 (`resume.test.ts`가 대조한다). 빌더를 바꾸면 다시 만든다.

```bash
pnpm --filter @ohmyti/context exec tsx -e 'import { writeFileSync } from "node:fs"; import { buildTextPdf, buildImageOnlyPdf, sampleResumeLines } from "./src/testing/pdf.ts"; writeFileSync("fixtures/resume-text.pdf", buildTextPdf([sampleResumeLines()])); writeFileSync("fixtures/resume-scanned.pdf", buildImageOnlyPdf(1));'
```
