import { eq, sql } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import {
  contextLinks,
  criterionResults,
  evidences,
  executionRecords,
  jobs,
  submissionContext,
  submissions,
} from "./schema";
import { DIGEST, SHA, seedEvaluation } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

/** drizzle은 DB 오류를 DrizzleQueryError로 감싸므로 제약 이름은 cause에서 찾는다. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "쿼리가 실패해야 합니다").toBeInstanceOf(Error);
  const err = caught as Error & { cause?: unknown };
  const cause = err.cause instanceof Error ? err.cause.message : "";
  expect(`${err.message}\n${cause}`).toMatch(pattern);
}

// 통합 테스트: DATABASE_URL_TEST의 서버에 임시 데이터베이스를 만들어 실행한다.
const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 DB 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("@ohmyti/db 스키마 (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  it("마이그레이션을 두 번 적용해도 두 번째는 변경이 없다", async () => {
    const before = await tdb.sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await runMigrations(tdb.db);
    const after = await tdb.sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("모든 필수 테이블이 존재한다", async () => {
    const rows = await tdb.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(
      [
        "assignments",
        "assignment_versions",
        "validation_samples",
        "submissions",
        "submission_context",
        "evaluations",
        "criterion_results",
        "evidences",
        "execution_records",
        "mutation_experiments",
        "review_events",
        "context_links",
        "interview_scorecards",
        "ai_reviews",
        "rubric_drafts",
        "jobs",
        "deletion_log",
      ].sort(),
    );
  });

  describe("execution_records 불변 (G-03)", () => {
    async function insertRecord() {
      const seed = await seedEvaluation(tdb.db);
      const [record] = await tdb.db
        .insert(executionRecords)
        .values({
          evaluationId: seed.evaluationId,
          kind: "HARNESS",
          submissionSha: SHA,
          rubricVersion: seed.rubricVersion,
          harnessVersion: "harness-0",
          environmentDigest: DIGEST,
          inputRef: "artifact://in",
          expectedRef: "artifact://expected",
          actualRef: "artifact://actual",
          exitCode: 0,
          failureKind: "NONE",
        })
        .returning({ id: executionRecords.id });
      if (!record) throw new Error("insert 실패");
      return record.id;
    }

    it("UPDATE를 거부한다", async () => {
      const id = await insertRecord();
      await expectDbError(
        tdb.db.update(executionRecords).set({ exitCode: 1 }).where(eq(executionRecords.id, id)),
        /immutable/,
      );
      const [row] = await tdb.db
        .select({ exitCode: executionRecords.exitCode })
        .from(executionRecords)
        .where(eq(executionRecords.id, id));
      expect(row?.exitCode).toBe(0);
    });

    it("DELETE를 거부한다", async () => {
      const id = await insertRecord();
      await expectDbError(
        tdb.db.delete(executionRecords).where(eq(executionRecords.id, id)),
        /immutable/,
      );
    });

    it("삭제 전용 설정을 같은 트랜잭션에서 켠 경우에만 DELETE가 된다 (T-506 경로)", async () => {
      const id = await insertRecord();
      await tdb.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
        await tx.delete(executionRecords).where(eq(executionRecords.id, id));
      });
      const rows = await tdb.db
        .select({ id: executionRecords.id })
        .from(executionRecords)
        .where(eq(executionRecords.id, id));
      expect(rows).toHaveLength(0);
    });
  });

  describe("criterion_results 제약 (G-02, G-04)", () => {
    function baseRow(seed: Awaited<ReturnType<typeof seedEvaluation>>) {
      return {
        evaluationId: seed.evaluationId,
        criterionId: "R-01",
        rubricVersion: seed.rubricVersion,
        maxPoints: 8,
        method: "EXECUTION" as const,
        observation: "정상 주문이 500을 반환했다",
        reviewState: "NOT_REQUIRED" as const,
      };
    }

    it("감점인데 evidence_ids가 비어 있으면 INSERT가 실패한다", async () => {
      const seed = await seedEvaluation(tdb.db);
      await expectDbError(
        tdb.db.insert(criterionResults).values({
          ...baseRow(seed),
          earnedPoints: 0,
          verdict: "FAIL",
          evidenceIds: [],
        }),
        /criterion_results_deduction_requires_evidence/,
      );
    });

    it("감점이고 evidence를 참조하면 INSERT가 된다", async () => {
      const seed = await seedEvaluation(tdb.db);
      const [evidence] = await tdb.db
        .insert(evidences)
        .values({ evaluationId: seed.evaluationId, submissionSha: SHA, artifactRefs: [] })
        .returning({ id: evidences.id });
      if (!evidence) throw new Error("evidence insert 실패");
      const [row] = await tdb.db
        .insert(criterionResults)
        .values({ ...baseRow(seed), earnedPoints: 0, verdict: "FAIL", evidenceIds: [evidence.id] })
        .returning({ id: criterionResults.id });
      expect(row?.id).toBeTruthy();
    });

    it("만점이면 evidence 없이도 INSERT가 된다", async () => {
      const seed = await seedEvaluation(tdb.db);
      const [row] = await tdb.db
        .insert(criterionResults)
        .values({ ...baseRow(seed), earnedPoints: 8, verdict: "PASS", evidenceIds: [] })
        .returning({ id: criterionResults.id });
      expect(row?.id).toBeTruthy();
    });

    it("INCONCLUSIVE는 earned_points가 null이어야 한다", async () => {
      const seed = await seedEvaluation(tdb.db);
      await expectDbError(
        tdb.db.insert(criterionResults).values({
          ...baseRow(seed),
          // 만점이라 G-02 제약에는 걸리지 않는다. INCONCLUSIVE + 숫자 점수만 위반이다
          earnedPoints: 8,
          verdict: "INCONCLUSIVE",
          evidenceIds: [],
        }),
        /criterion_results_inconclusive_is_null/,
      );
      const [row] = await tdb.db
        .insert(criterionResults)
        .values({
          ...baseRow(seed),
          earnedPoints: null,
          verdict: "INCONCLUSIVE",
          evidenceIds: [],
          reviewState: "PENDING",
        })
        .returning({ id: criterionResults.id });
      expect(row?.id).toBeTruthy();
    });

    it("earned_points는 max_points를 넘을 수 없다", async () => {
      const seed = await seedEvaluation(tdb.db);
      await expectDbError(
        tdb.db
          .insert(criterionResults)
          .values({ ...baseRow(seed), earnedPoints: 9, verdict: "PASS", evidenceIds: [] }),
        /criterion_results_earned_range/,
      );
    });
  });

  it("context_links에는 점수 관련 컬럼이 없다 (DB 컬럼 목록 대조)", async () => {
    const rows = await tdb.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'context_links'`;
    const names = rows.map((r) => r.column_name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/score|point|earned/i);
    }
  });

  it("submission_context는 채점 테이블과 분리되어 있고 이력서 컬럼은 여기에만 있다", async () => {
    const rows = await tdb.sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name ~ 'resume'`;
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(["submission_context"]));
  });

  it("jobs.dedupe_key는 QUEUED·RUNNING일 때만 유일하다", async () => {
    const key = `evaluate:${crypto.randomUUID()}`;
    const [first] = await tdb.db
      .insert(jobs)
      .values({ type: "EVALUATE_SUBMISSION", payload: {}, dedupeKey: key })
      .returning({ id: jobs.id });
    if (!first) throw new Error("job insert 실패");

    await expectDbError(
      tdb.db.insert(jobs).values({ type: "EVALUATE_SUBMISSION", payload: {}, dedupeKey: key }),
      /jobs_dedupe_key_active_idx/,
    );

    await tdb.db.update(jobs).set({ status: "SUCCEEDED" }).where(eq(jobs.id, first.id));
    const [second] = await tdb.db
      .insert(jobs)
      .values({ type: "EVALUATE_SUBMISSION", payload: {}, dedupeKey: key })
      .returning({ id: jobs.id });
    expect(second?.id).toBeTruthy();
  });

  it("jobs(status, run_after) 인덱스가 있다", async () => {
    const rows = await tdb.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'jobs' and indexname = 'jobs_status_run_after_idx'`;
    expect(rows[0]?.indexdef).toMatch(/\(status, run_after\)/);
  });

  it("submissions.submission_sha는 40자 hex만 허용한다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await expectDbError(
      tdb.db.insert(submissions).values({
        assignmentVersionId: seed.assignmentVersionId,
        repoUrl: "https://github.com/example/x",
        submissionSha: "not-a-sha",
      }),
      /submissions_sha_format/,
    );
  });

  it("제출을 지우면 submission_context와 context_links가 함께 지워진다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await tdb.db
      .insert(submissionContext)
      .values({ submissionId: seed.submissionId, resumeText: "이력서" });
    await tdb.db.insert(contextLinks).values({
      submissionId: seed.submissionId,
      claim: "Node.js 백엔드 3년",
      status: "NO_DATA",
    });
    await tdb.db.delete(submissions).where(eq(submissions.id, seed.submissionId));
    const ctx = await tdb.db
      .select()
      .from(submissionContext)
      .where(eq(submissionContext.submissionId, seed.submissionId));
    const links = await tdb.db
      .select()
      .from(contextLinks)
      .where(eq(contextLinks.submissionId, seed.submissionId));
    expect(ctx).toHaveLength(0);
    expect(links).toHaveLength(0);
  });
});

describe("@ohmyti/db 스키마 (단위)", () => {
  it("context_links Drizzle 정의에도 점수 관련 컬럼이 없다", () => {
    const columns = getTableColumns(contextLinks);
    const names = Object.values(columns).map((c) => c.name);
    expect(names).toContain("claim");
    for (const name of names) {
      expect(name).not.toMatch(/score|point|earned/i);
    }
  });
});
