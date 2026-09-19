import { pingDatabase, type Database } from "@ohmyti/db";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger";
import type { Worker, WorkerStatus } from "./worker";

export interface HealthServer {
  port: number;
  close: () => Promise<void>;
}

export interface HealthReport {
  ok: boolean;
  workerId: string;
  running: boolean;
  stopping: boolean;
  activeJobs: number;
  dormant: boolean;
  lastPollAt: string | null;
  /** 유휴 대기 중에는 DB에 붙지 않는다 (`skipped`). 연결이 나가는 트래픽이 되어 Railway가 서비스를 재우지 못한다 */
  db: "ok" | "error" | "skipped";
  processed: WorkerStatus["processed"];
}

/** 워커 상태와 DB 연결을 확인해 보고서를 만든다. 루프가 돌고 DB가 응답하면(유휴 대기 중이면 확인 없이) ok. */
export async function buildHealthReport(worker: Worker, db: Database): Promise<HealthReport> {
  const status = worker.status();
  let dbState: HealthReport["db"] = "skipped";
  if (!status.dormant) {
    try {
      await pingDatabase(db);
      dbState = "ok";
    } catch {
      dbState = "error";
    }
  }
  return {
    ok: status.running && !status.stopping && dbState !== "error",
    workerId: status.workerId,
    running: status.running,
    stopping: status.stopping,
    activeJobs: status.activeJobs,
    dormant: status.dormant,
    lastPollAt: status.lastPollAt?.toISOString() ?? null,
    db: dbState,
    processed: status.processed,
  };
}

/**
 * `GET /healthz`(Railway 헬스 체크)와 `/wake`(유휴 대기 해제)만 제공하는 HTTP 서버. 그 외 경로는 404.
 * `/wake`는 인증하지 않는다. 하는 일이 폴링 재개뿐이고, Railway는 어떤 요청이 와도 재운 서비스를 깨운다.
 * 응답 본문에는 비밀값이 들어가지 않는다 (job payload·에러 메시지를 포함하지 않는다).
 */
export function startHealthServer(options: {
  port: number;
  worker: Worker;
  db: Database;
  logger: Logger;
}): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    const pathname = req.url?.split("?")[0];
    if (pathname === "/wake" && (req.method === "POST" || req.method === "GET")) {
      const wasDormant = options.worker.status().dormant;
      options.worker.wake();
      res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, wasDormant }));
      return;
    }
    if (req.method !== "GET" || pathname !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    buildHealthReport(options.worker, options.db)
      .then((report) => {
        res.writeHead(report.ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      })
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "헬스 체크 응답 생성에 실패했습니다");
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      });
  });
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      const port = (server.address() as AddressInfo).port;
      options.logger.info({ port }, "헬스 서버 시작");
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
