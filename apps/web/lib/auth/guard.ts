import { type AccessConfig } from "./config";
import { isPublicPath } from "./paths";
import { verifySessionToken } from "./session";

export interface GuardInput {
  pathname: string;
  search: string;
  method: string;
  /** `Accept` 헤더. HTML 탐색이면 로그인 페이지로 보내고, 아니면 401을 준다. */
  accept: string | null;
  sessionToken: string | undefined;
}

export type GuardDecision =
  { kind: "allow" } | { kind: "redirect"; location: string } | { kind: "unauthorized" };

function isHtmlNavigation(input: GuardInput): boolean {
  if (input.method !== "GET" && input.method !== "HEAD") return false;
  if (input.pathname.startsWith("/api/")) return false;
  return (input.accept ?? "").includes("text/html");
}

export async function decideAccess(
  input: GuardInput,
  config: AccessConfig,
  now: Date = new Date(),
): Promise<GuardDecision> {
  if (!config.enabled) return { kind: "allow" };
  if (isPublicPath(input.pathname)) return { kind: "allow" };

  const verdict = await verifySessionToken(input.sessionToken, config.secret, now);
  if (verdict.valid) return { kind: "allow" };

  if (isHtmlNavigation(input)) {
    const returnTo = `${input.pathname}${input.search}`;
    return { kind: "redirect", location: `/login?next=${encodeURIComponent(returnTo)}` };
  }
  return { kind: "unauthorized" };
}
