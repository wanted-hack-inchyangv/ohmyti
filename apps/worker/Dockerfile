# 워커 이미지. 빌드 컨텍스트는 저장소 루트다:
#   docker build -f apps/worker/Dockerfile -t ohmyti-worker .
# 1) deps: 워크스페이스 전체 설치 (frozen lockfile)
# 2) build: esbuild 번들(dist/index.js, dist/migrate.js) + `pnpm deploy`로 워커의 프로덕션 의존성만 추출
# 3) template: 승인 실행 템플릿(templates/<name>)의 고정 의존성을 lockfile 그대로 설치 (T-102)
# 4) runtime: 비관리자 사용자 runner, /app에 dist·node_modules·drizzle, /opt/templates/<name>에 템플릿

ARG NODE_IMAGE=node:22.23.2-bookworm-slim
ARG PNPM_VERSION=10.33.3

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
# 러너(T-203)와 하네스(T-204)는 워커의 런타임 의존성이다.
COPY packages/runner/package.json packages/runner/
COPY packages/harness/package.json packages/harness/
# 관련 함수 그래프 분석(T-304)은 워커의 런타임 의존성이다 (ts-morph).
COPY packages/analysis/package.json packages/analysis/
# LLM 어댑터(T-401)는 mutation 위치 제안·근거 리뷰·기준 초안의 런타임 의존성이다 (openai SDK).
COPY packages/llm/package.json packages/llm/
# 이력서 텍스트 추출(T-501)은 CONTEXT_LINK 단계의 런타임 의존성이다 (unpdf).
COPY packages/context/package.json packages/context/
# 워커와 그 의존 패키지만 설치한다. 다른 워크스페이스 패키지의 매니페스트는 lockfile에 있으므로 필요 없다.
RUN pnpm install --frozen-lockfile --filter @ohmyti/worker...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/storage packages/storage
# 지원 여부 판정(T-203)이 러너를, 오케스트레이터(T-204)가 러너·하네스를 번들한다.
COPY packages/runner packages/runner
COPY packages/harness packages/harness
COPY packages/analysis packages/analysis
COPY packages/llm packages/llm
COPY packages/context packages/context
COPY apps/worker apps/worker
RUN pnpm --filter @ohmyti/worker build
# 워커의 프로덕션 의존성만 담은 트리를 /out에 만든다 (외부 모듈은 번들 밖이라 런타임에 필요하다).
RUN pnpm --filter @ohmyti/worker deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS template
WORKDIR /opt/templates/order-api-ts
COPY templates/order-api-ts/package.json templates/order-api-ts/package-lock.json templates/order-api-ts/template.json ./
# 제출물의 npm install은 어떤 러너도 실행하지 않는다. 템플릿 의존성만 여기서 한 번 설치한다.
RUN npm ci --no-audit --no-fund \
 && node -e ' \
    const { allowedDependencies } = require("./template.json"); \
    const bad = Object.entries(allowedDependencies) \
      .filter(([n, v]) => { try { return require(`./node_modules/${n}/package.json`).version !== v; } catch { return true; } }) \
      .map(([n, v]) => `${n}@${v}`); \
    if (bad.length) { console.error("템플릿 의존성 불일치:", bad.join(" ")); process.exit(1); } \
    console.log(`템플릿 order-api-ts: 허용 의존성 ${Object.keys(allowedDependencies).length}개 확인`);'

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV TEMPLATE_ROOT=/opt/templates
ENV MIGRATIONS_FOLDER=/app/drizzle
# 비관리자 사용자. 제출 코드 실행(T-108)도 이 사용자로 돈다.
RUN groupadd --system --gid 10001 runner \
 && useradd --system --uid 10001 --gid runner --home-dir /home/runner --create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /app /opt/templates \
 && chown -R runner:runner /app /opt/templates
WORKDIR /app
COPY --from=build --chown=runner:runner /out/package.json ./package.json
COPY --from=build --chown=runner:runner /out/node_modules ./node_modules
COPY --from=build --chown=runner:runner /repo/apps/worker/dist ./dist
COPY --from=build --chown=runner:runner /repo/packages/db/drizzle ./drizzle
# 템플릿은 root 소유다(chown 없음). runner는 읽고 실행만 할 수 있고 고칠 수 없다.
COPY --from=template /opt/templates/order-api-ts /opt/templates/order-api-ts
USER runner
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
