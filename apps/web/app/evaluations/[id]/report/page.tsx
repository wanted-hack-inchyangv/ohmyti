import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { buildHiringReportView } from "@/lib/reports/hiring-report-view";
import { readHiringReport } from "@/lib/reports/hiring-report";
import { readEvaluationReport } from "@/lib/reports/service";
import { requestOrigin } from "@/lib/request-path";
import { HiringReportDocument } from "./report-document";

export const metadata: Metadata = { title: "채용 리포트 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

/**
 * 채용 리포트 화면 (TICKET.md T-706, PRD 14.3). 조립(T-705)이 만든 9개 절을 한 페이지 문서로 그린다.
 * 인쇄(A4)와 Markdown 복사가 내보내기이며 서버에서 PDF를 만들지 않는다.
 * 근거 딥링크와 기준의 판정 조건에 쓸 저장값은 `GET /api/evaluations/[id]`와 같은 `readEvaluationReport`에서 온다.
 */
export default async function HiringReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deps = { db: getDb().db, store: getArtifactStore() };
  const [report, hiring] = await Promise.all([
    readEvaluationReport({ db: deps.db }, id),
    readHiringReport(deps, id),
  ]);
  if (!report.ok) {
    if (report.code === "EVALUATION_NOT_FOUND" || report.code === "INVALID_INPUT") notFound();
    throw new Error(report.message);
  }
  if (!hiring.ok) {
    if (hiring.code === "EVALUATION_NOT_FOUND" || hiring.code === "INVALID_INPUT") notFound();
    throw new Error(hiring.message);
  }
  const view = buildHiringReportView({
    report: report.data,
    hiring: hiring.data,
    origin: requestOrigin(await headers()),
  });
  return <HiringReportDocument view={view} />;
}
