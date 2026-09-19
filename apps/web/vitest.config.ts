import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig의 jsx: preserve는 Next.js용이다. 테스트 변환(oxc)은 자동 런타임으로 JSX를 처리한다.
  oxc: { jsx: { runtime: "automatic" } },
  // tsconfig paths의 `@/*`를 Vitest에서도 같은 위치로 푼다.
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    name: "@ohmyti/web",
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
  },
});
