import type { Metadata } from "next";
import { LinkButton, Notice } from "@/components/ui";
import { resolveAccessConfig } from "@/lib/auth/config";
import { sanitizeReturnPath } from "@/lib/auth/paths";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "로그인 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ next?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = sanitizeReturnPath(rawNext);
  const config = resolveAccessConfig(process.env);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <div className="flex flex-col gap-8 rounded-xl border border-neutral-200 bg-surface p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-sm font-bold text-surface"
          >
            CG
          </span>
          <h1 className="text-2xl font-bold tracking-tight">CodeGraph Reviewer</h1>
          <p className="text-[15px] leading-relaxed text-neutral-600">
            이력서와 제출물이 저장되는 검토 도구입니다. 접근 비밀번호를 입력해 주세요.
          </p>
        </div>
        {config.enabled ? (
          <LoginForm next={next} />
        ) : (
          <div className="flex flex-col gap-4">
            <Notice tone="neutral">
              개발 모드에서 <code className="font-mono text-[13px]">APP_ACCESS_PASSWORD</code>가
              설정되지 않아 접근 보호가 꺼져 있습니다.
            </Notice>
            <LinkButton href={next} variant="primary" size="lg" className="w-full">
              계속 진행
            </LinkButton>
          </div>
        )}
      </div>
    </main>
  );
}
