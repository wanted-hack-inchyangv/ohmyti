/** `SANDBOX_RUNNER`로 러너 구현을 고른다 (TICKET.md 1.4). 워커와 게이트 스크립트가 같은 함수를 쓴다. */
import type { ArtifactStore } from "@ohmyti/storage";
import { loadLocalRunnerConfig, loadVercelRunnerConfig } from "./config";
import { LocalProcessRunner } from "./local/local-runner";
import type { SandboxRunner } from "./runner";
import { RUNNER_KINDS } from "./template";
import { VercelSandboxRunner } from "./vercel/vercel-runner";

export interface CreateRunnerOptions {
  artifactStore: ArtifactStore;
  secrets?: readonly string[];
  /** `SANDBOX_RUNNER` 값을 직접 지정 (환경변수보다 우선) */
  kind?: string | undefined;
}

export function createRunnerFromEnv(
  env: Record<string, string | undefined>,
  options: CreateRunnerOptions,
): SandboxRunner {
  const kind = options.kind?.trim() || env.SANDBOX_RUNNER?.trim() || "local";
  const common = {
    artifactStore: options.artifactStore,
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
  if (kind === "local") {
    return new LocalProcessRunner({ config: loadLocalRunnerConfig(env), ...common });
  }
  if (kind === "vercel") {
    return new VercelSandboxRunner({ config: loadVercelRunnerConfig(env), ...common });
  }
  throw new Error(
    `SANDBOX_RUNNER=${JSON.stringify(kind)}은(는) 지원하지 않습니다 (${RUNNER_KINDS.join(" | ")})`,
  );
}
