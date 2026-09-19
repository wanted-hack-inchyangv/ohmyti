/**
 * Vercel Sandbox SDK(`@vercel/sandbox` 3.3.0) 위에 얹는 얇은 클라이언트 추상화 (T-209).
 * `VercelSandboxRunner`는 이 인터페이스만 쓰므로 테스트는 SDK 없이 더블로 teardown·명령 순서를 검증한다.
 * 실제 구현(`vercelSandboxClient`)이 SDK의 세부 API(detached Command, `stdout`/`stderr` Writable, `updateNetworkPolicy`)를 감싼다.
 */
import { Writable } from "node:stream";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";

export type SandboxNetworkPolicy = NetworkPolicy;

export interface SandboxCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export interface CreateSandboxOptions {
  /** VCR 이미지 (예: `vercel/sandbox/node:22`) */
  image: string;
  /** 세션 제한 시간. 지나면 VM이 멈추고 진행 중인 명령은 거부된다 */
  timeoutMs: number;
  vcpus: number;
  /** 노출할 포트. 서비스가 `0.0.0.0`에 바인드해야 도달할 수 있다 */
  ports: number[];
  region?: string | undefined;
  networkPolicy: SandboxNetworkPolicy;
  /** 모든 명령이 상속하는 환경변수 */
  env: Record<string, string>;
  tags?: Record<string, string> | undefined;
  credentials?: SandboxCredentials | undefined;
}

export interface SandboxCommandParams {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  sudo?: boolean | undefined;
  /** stdout·stderr 조각을 받는다. 순서는 스트림별로 보장된다 */
  onStdout?: ((chunk: Buffer) => void) | undefined;
  onStderr?: ((chunk: Buffer) => void) | undefined;
}

export interface SandboxCommandFinished {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** detached로 띄운 프로세스 핸들 */
export interface SandboxProcess {
  /** 종료까지 기다린다. 세션이 먼저 끝나면 거부된다 */
  wait(): Promise<{ exitCode: number | null }>;
  kill(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface SandboxHandle {
  readonly id: string;
  /** 세션의 기본 작업 디렉터리 (이미지마다 다르다, 예: `/vercel/sandbox`). 환경 루트로 쓴다 */
  readonly cwd: string;
  /** 노출한 포트의 공개 URL (`https://…`) */
  domain(port: number): string;
  /** 명령을 실행하고 끝날 때까지 기다린다. 종료 코드가 0이 아니어도 거부하지 않는다 */
  runCommand(params: SandboxCommandParams): Promise<SandboxCommandFinished>;
  /** 명령을 detached로 띄운다 */
  startCommand(params: SandboxCommandParams): Promise<SandboxProcess>;
  writeFiles(files: { path: string; content: Uint8Array; mode?: number }[]): Promise<void>;
  /** 없으면 null */
  readFile(path: string): Promise<Uint8Array | null>;
  updateNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  /** VM을 멈춘다. 여러 번 호출해도 안전해야 한다 */
  stop(): Promise<void>;
}

export interface SandboxClient {
  create(options: CreateSandboxOptions): Promise<SandboxHandle>;
}

/** `@vercel/sandbox`로 실제 VM을 만드는 클라이언트 */
export function vercelSandboxClient(): SandboxClient {
  return {
    async create(options) {
      const sandbox = await Sandbox.create({
        image: options.image,
        timeout: options.timeoutMs,
        resources: { vcpus: options.vcpus },
        ports: options.ports,
        ...(options.region ? { region: options.region } : {}),
        networkPolicy: options.networkPolicy,
        env: options.env,
        ...(options.tags ? { tags: options.tags } : {}),
        // 일회성 환경: 스냅샷을 남기지 않는다 (저장 비용·잔존 데이터 없음)
        persistent: false,
        ...(options.credentials ?? {}),
      });
      return wrapSandbox(sandbox);
    },
  };
}

function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  let stopped: Promise<void> | null = null;
  return {
    id: sandbox.name,
    cwd: sandbox.cwd,
    domain: (port) => sandbox.domain(port),
    async runCommand(params) {
      const finished = await sandbox.runCommand({
        cmd: params.cmd,
        args: params.args,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.sudo ? { sudo: true } : {}),
        ...(params.onStdout ? { stdout: sink(params.onStdout) } : {}),
        ...(params.onStderr ? { stderr: sink(params.onStderr) } : {}),
      });
      return {
        exitCode: finished.exitCode,
        stdout: await finished.stdout(),
        stderr: await finished.stderr(),
      };
    },
    async startCommand(params) {
      const command = await sandbox.runCommand({
        cmd: params.cmd,
        args: params.args,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.sudo ? { sudo: true } : {}),
        ...(params.onStdout ? { stdout: sink(params.onStdout) } : {}),
        ...(params.onStderr ? { stderr: sink(params.onStderr) } : {}),
        detached: true,
      });
      return {
        async wait() {
          const finished = await command.wait();
          return { exitCode: finished.exitCode };
        },
        kill: (signal) => command.kill(signal),
      };
    },
    writeFiles: (files) =>
      sandbox.writeFiles(
        files.map((f) => ({
          path: f.path,
          content: f.content,
          ...(f.mode === undefined ? {} : { mode: f.mode }),
        })),
      ),
    async readFile(path) {
      const buffer = await sandbox.readFileToBuffer({ path });
      return buffer === null ? null : new Uint8Array(buffer);
    },
    async updateNetworkPolicy(policy) {
      await sandbox.updateNetworkPolicy(policy);
    },
    stop() {
      if (!stopped) {
        stopped = sandbox.stop().then(() => undefined);
      }
      return stopped;
    },
  };
}

/** SDK가 로그 조각을 쓰는 Writable. 문자열이 오면 UTF-8 바이트로 바꾼다 */
function sink(onChunk: (chunk: Buffer) => void): Writable {
  const writable = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      onChunk(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      callback();
    },
  });
  // SDK가 스트리밍 오류를 `error`로 내면 프로세스가 죽지 않도록 흡수한다 (세션 종료 뒤 로그 조회 실패 등)
  writable.on("error", () => undefined);
  return writable;
}
