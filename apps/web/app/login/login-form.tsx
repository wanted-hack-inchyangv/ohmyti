"use client";

import { buttonClass, inputClassName } from "@/components/ui";
import { useState, type FormEvent } from "react";

interface LoginFormProps {
  next: string;
}

export function LoginForm({ next }: LoginFormProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, next }),
      });
      const body = (await response.json()) as { ok: boolean; redirectTo?: string; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "로그인에 실패했습니다");
        return;
      }
      window.location.assign(body.redirectTo ?? "/");
    } catch {
      setError("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
      aria-describedby={error ? "login-error" : undefined}
    >
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-[15px] font-semibold text-ink">접근 비밀번호</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? true : undefined}
          className={inputClassName}
        />
      </label>
      {error ? (
        <p id="login-error" role="alert" className="-mt-2 text-[13px] font-medium text-fail">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className={`${buttonClass("primary", "lg")} w-full`}
      >
        {submitting ? "확인 중…" : "들어가기"}
      </button>
    </form>
  );
}
