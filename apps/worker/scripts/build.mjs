// 워커를 단일 ESM 파일로 번들한다. 워크스페이스 패키지(@ohmyti/*)는 소스에서 함께 번들하고,
// 그 외 node_modules 의존성은 외부로 남겨 런타임에 로드한다.
// 따라서 @ohmyti/* 패키지가 쓰는 외부 의존성(zod, drizzle-orm, postgres, @vercel/blob 등)은
// apps/worker/package.json의 dependencies에도 같은 버전으로 있어야 pnpm이 dist/index.js 옆에서 찾을 수 있다.
import { build } from "esbuild";

const externalNodeModules = {
  name: "external-node-modules",
  setup(api) {
    api.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@ohmyti/")) return null;
      return { path: args.path, external: true };
    });
  },
};

await build({
  // index.js: 워커 프로세스, migrate.js: Railway preDeployCommand용 마이그레이션 실행기,
  // analysis-child.js: 관련 함수 그래프 분석 자식 프로세스 (T-304). 이름은 @ohmyti/analysis의 CHILD_BUNDLE_NAME과 같아야 한다
  entryPoints: {
    index: "src/index.ts",
    migrate: "src/migrate.ts",
    "analysis-child": "../../packages/analysis/src/child.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  plugins: [externalNodeModules],
  logLevel: "info",
});
