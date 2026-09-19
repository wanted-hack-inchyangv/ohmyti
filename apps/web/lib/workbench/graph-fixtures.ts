/**
 * 관련 함수 그래프 픽스처 (T-304). `@ohmyti/analysis`로 샘플 A(`samples/order-api/impl-a`)를 실제로 분석한 결과다.
 * 케이스 R-05(멱등 재전송)와 R-10(헬스·리셋)의 timeline 요청으로 만든 서브그래프이며, 값은 분석기 출력 그대로다.
 * (재생성: analyzeFunctionGraph({ files: directoryFiles("samples/order-api/impl-a"), cases: [R-05, R-10 요청] }))
 */
import {
  FunctionGraphAnalysisSchema,
  type FunctionGraphAnalysis,
  type FunctionGraphReport,
} from "@ohmyti/core";
import { FIXTURE_EVALUATION_ID } from "./fixtures";

export const R05_CASE_ID = "R-05-idempotent-resend";
export const R10_CASE_ID = "R-10-health-and-reset";

const ANALYSIS_A = {
  status: "ok",
  analyzerVersion: "1",
  fileCount: 22,
  functionCount: 40,
  routes: [
    {
      method: "GET",
      path: "/health",
      handler: {
        id: "src/http/routes.ts:11-13",
        name: "GET /health",
        location: {
          path: "src/http/routes.ts",
          startLine: 11,
          endLine: 13,
        },
      },
    },
    {
      method: "POST",
      path: "/admin/reset",
      handler: {
        id: "src/http/routes.ts:15-18",
        name: "POST /admin/reset",
        location: {
          path: "src/http/routes.ts",
          startLine: 15,
          endLine: 18,
        },
      },
    },
    {
      method: "GET",
      path: "/products/:id",
      handler: {
        id: "src/http/routes.ts:20-23",
        name: "GET /products/:id",
        location: {
          path: "src/http/routes.ts",
          startLine: 20,
          endLine: 23,
        },
      },
    },
    {
      method: "POST",
      path: "/orders",
      handler: {
        id: "src/http/routes.ts:25-28",
        name: "POST /orders",
        location: {
          path: "src/http/routes.ts",
          startLine: 25,
          endLine: 28,
        },
      },
    },
    {
      method: "GET",
      path: "/orders/:id",
      handler: {
        id: "src/http/routes.ts:30-33",
        name: "GET /orders/:id",
        location: {
          path: "src/http/routes.ts",
          startLine: 30,
          endLine: 33,
        },
      },
    },
    {
      method: "POST",
      path: "/orders/:id/cancel",
      handler: {
        id: "src/http/routes.ts:35-38",
        name: "POST /orders/:id/cancel",
        location: {
          path: "src/http/routes.ts",
          startLine: 35,
          endLine: 38,
        },
      },
    },
  ],
  cases: [
    {
      caseId: "R-05-idempotent-resend",
      roots: [
        {
          method: "GET",
          path: "/products/:id",
        },
        {
          method: "POST",
          path: "/orders",
        },
        {
          method: "GET",
          path: "/orders/:id",
        },
      ],
      unmatchedRequests: [],
      nodes: [
        {
          id: "src/http/routes.ts:20-23",
          name: "GET /products/:id",
          kind: "handler",
          location: {
            path: "src/http/routes.ts",
            startLine: 20,
            endLine: 23,
          },
          route: {
            method: "GET",
            path: "/products/:id",
          },
          observed: true,
          depth: 0,
        },
        {
          id: "src/http/routes.ts:25-28",
          name: "POST /orders",
          kind: "handler",
          location: {
            path: "src/http/routes.ts",
            startLine: 25,
            endLine: 28,
          },
          route: {
            method: "POST",
            path: "/orders",
          },
          observed: true,
          depth: 0,
        },
        {
          id: "src/http/routes.ts:30-33",
          name: "GET /orders/:id",
          kind: "handler",
          location: {
            path: "src/http/routes.ts",
            startLine: 30,
            endLine: 33,
          },
          route: {
            method: "GET",
            path: "/orders/:id",
          },
          observed: true,
          depth: 0,
        },
        {
          id: "src/domain/order-service.ts:39-43",
          name: "OrderService.getProduct",
          kind: "method",
          location: {
            path: "src/domain/order-service.ts",
            startLine: 39,
            endLine: 43,
          },
          route: null,
          observed: false,
          depth: 1,
        },
        {
          id: "src/domain/order-service.ts:55-96",
          name: "OrderService.createOrder",
          kind: "method",
          location: {
            path: "src/domain/order-service.ts",
            startLine: 55,
            endLine: 96,
          },
          route: null,
          observed: false,
          depth: 1,
        },
        {
          id: "src/domain/order-service.ts:45-49",
          name: "OrderService.getOrder",
          kind: "method",
          location: {
            path: "src/domain/order-service.ts",
            startLine: 45,
            endLine: 49,
          },
          route: null,
          observed: false,
          depth: 1,
        },
        {
          id: "src/repository/in-memory.ts:15-18",
          name: "InMemoryProductRepository.findById",
          kind: "method",
          location: {
            path: "src/repository/in-memory.ts",
            startLine: 15,
            endLine: 18,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/errors.ts:19-24",
          name: "AppError.constructor",
          kind: "method",
          location: {
            path: "src/domain/errors.ts",
            startLine: 19,
            endLine: 24,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/validation.ts:13-24",
          name: "validateIdempotencyKey",
          kind: "function",
          location: {
            path: "src/domain/validation.ts",
            startLine: 13,
            endLine: 24,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/validation.ts:26-41",
          name: "validateCreateOrderBody",
          kind: "function",
          location: {
            path: "src/domain/validation.ts",
            startLine: 26,
            endLine: 41,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/digest.ts:5-8",
          name: "requestDigest",
          kind: "function",
          location: {
            path: "src/domain/digest.ts",
            startLine: 5,
            endLine: 8,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/mutex.ts:8-20",
          name: "Mutex.run",
          kind: "method",
          location: {
            path: "src/domain/mutex.ts",
            startLine: 8,
            endLine: 20,
          },
          route: null,
          observed: false,
          depth: 2,
        },
      ],
      edges: [
        {
          from: "src/domain/order-service.ts:39-43",
          to: "src/repository/in-memory.ts:15-18",
        },
        {
          from: "src/domain/order-service.ts:39-43",
          to: "src/domain/errors.ts:19-24",
        },
        {
          from: "src/domain/order-service.ts:45-49",
          to: "src/domain/errors.ts:19-24",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/domain/validation.ts:13-24",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/domain/validation.ts:26-41",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/domain/digest.ts:5-8",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/domain/mutex.ts:8-20",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/domain/errors.ts:19-24",
        },
        {
          from: "src/domain/order-service.ts:55-96",
          to: "src/repository/in-memory.ts:15-18",
        },
        {
          from: "src/domain/validation.ts:13-24",
          to: "src/domain/errors.ts:19-24",
        },
        {
          from: "src/domain/validation.ts:26-41",
          to: "src/domain/errors.ts:19-24",
        },
        {
          from: "src/http/routes.ts:20-23",
          to: "src/domain/order-service.ts:39-43",
        },
        {
          from: "src/http/routes.ts:25-28",
          to: "src/domain/order-service.ts:55-96",
        },
        {
          from: "src/http/routes.ts:30-33",
          to: "src/domain/order-service.ts:45-49",
        },
      ],
      truncated: true,
      omittedCount: 5,
    },
    {
      caseId: "R-10-health-and-reset",
      roots: [
        {
          method: "POST",
          path: "/admin/reset",
        },
        {
          method: "GET",
          path: "/health",
        },
      ],
      unmatchedRequests: [],
      nodes: [
        {
          id: "src/http/routes.ts:15-18",
          name: "POST /admin/reset",
          kind: "handler",
          location: {
            path: "src/http/routes.ts",
            startLine: 15,
            endLine: 18,
          },
          route: {
            method: "POST",
            path: "/admin/reset",
          },
          observed: true,
          depth: 0,
        },
        {
          id: "src/http/routes.ts:11-13",
          name: "GET /health",
          kind: "handler",
          location: {
            path: "src/http/routes.ts",
            startLine: 11,
            endLine: 13,
          },
          route: {
            method: "GET",
            path: "/health",
          },
          observed: true,
          depth: 0,
        },
        {
          id: "src/domain/order-service.ts:114-120",
          name: "OrderService.reset",
          kind: "method",
          location: {
            path: "src/domain/order-service.ts",
            startLine: 114,
            endLine: 120,
          },
          route: null,
          observed: false,
          depth: 1,
        },
        {
          id: "src/domain/mutex.ts:8-20",
          name: "Mutex.run",
          kind: "method",
          location: {
            path: "src/domain/mutex.ts",
            startLine: 8,
            endLine: 20,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/repository/in-memory.ts:26-29",
          name: "InMemoryProductRepository.reset",
          kind: "method",
          location: {
            path: "src/repository/in-memory.ts",
            startLine: 26,
            endLine: 29,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/domain/seed.ts:4-10",
          name: "seedProducts",
          kind: "function",
          location: {
            path: "src/domain/seed.ts",
            startLine: 4,
            endLine: 10,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/repository/in-memory.ts:54-57",
          name: "InMemoryOrderRepository.reset",
          kind: "method",
          location: {
            path: "src/repository/in-memory.ts",
            startLine: 54,
            endLine: 57,
          },
          route: null,
          observed: false,
          depth: 2,
        },
        {
          id: "src/repository/in-memory.ts:73-76",
          name: "InMemoryIdempotencyStore.reset",
          kind: "method",
          location: {
            path: "src/repository/in-memory.ts",
            startLine: 73,
            endLine: 76,
          },
          route: null,
          observed: false,
          depth: 2,
        },
      ],
      edges: [
        {
          from: "src/domain/order-service.ts:114-120",
          to: "src/domain/mutex.ts:8-20",
        },
        {
          from: "src/domain/order-service.ts:114-120",
          to: "src/repository/in-memory.ts:26-29",
        },
        {
          from: "src/domain/order-service.ts:114-120",
          to: "src/domain/seed.ts:4-10",
        },
        {
          from: "src/domain/order-service.ts:114-120",
          to: "src/repository/in-memory.ts:54-57",
        },
        {
          from: "src/domain/order-service.ts:114-120",
          to: "src/repository/in-memory.ts:73-76",
        },
        {
          from: "src/http/routes.ts:15-18",
          to: "src/domain/order-service.ts:114-120",
        },
      ],
      truncated: false,
      omittedCount: 0,
    },
  ],
};

export function functionGraphAnalysisFixture(): FunctionGraphAnalysis {
  return FunctionGraphAnalysisSchema.parse(structuredClone(ANALYSIS_A));
}

export function unavailableAnalysisFixture(
  reason = "문법 오류: src/domain/broken-draft.ts:1 '{' expected.",
): FunctionGraphAnalysis {
  return { status: "unavailable", analyzerVersion: "1", reason };
}

export function functionGraphReportFixture(
  analysis: FunctionGraphAnalysis = functionGraphAnalysisFixture(),
  evaluationId: string = FIXTURE_EVALUATION_ID,
): FunctionGraphReport {
  return {
    evaluationId,
    artifactKey: `evaluations/${evaluationId}/analysis/function-graph.json`,
    analysis,
  };
}
