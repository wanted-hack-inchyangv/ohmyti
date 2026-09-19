/**
 * 자식 프로세스 그룹 관리 (T-108).
 * `detached: true`로 띄워 자식이 새 프로세스 그룹의 리더가 되게 하고, 종료할 때 그룹 전체(`-pid`)에
 * 신호를 보내 손자 프로세스까지 정리한다. stdout·stderr는 상한까지만 보관한다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface BoundedOutput {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** 상한까지의 바이트만 모으는 버퍼. 넘는 부분은 버리고 `truncated`로 표시한다. */
export class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private total = 0;
  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    const room = this.maxBytes - this.kept;
    if (room <= 0) return;
    const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.kept += slice.byteLength;
  }

  snapshot(): BoundedOutput {
    return {
      text: Buffer.concat(this.chunks).toString("utf8"),
      truncated: this.total > this.kept,
      bytes: this.total,
    };
  }
}

export interface SpawnGroupOptions {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  maxOutputBytes: number;
}

export interface ProcessGroupExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** 프로세스 그룹에 아직 프로세스가 남아 있는지 (`kill(-pgid, 0)`) */
export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: 프로세스는 있지만 신호를 보낼 권한이 없다 (살아 있다고 본다)
    return code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 그룹에 SIGTERM을 보내고 `graceMs` 안에 비지 않으면 SIGKILL을 보낸다.
 * 리더가 종료된 뒤에도 손자가 남아 있을 수 있으므로 그룹이 빌 때까지 짧게 재확인한다.
 */
export async function killGroup(pgid: number, graceMs: number): Promise<void> {
  if (!isGroupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return;
    await sleep(25);
  }
  signalGroup(pgid, "SIGKILL");
  // SIGKILL 뒤 커널이 정리할 시간을 잠깐 준다
  for (let i = 0; i < 40 && isGroupAlive(pgid); i += 1) {
    await sleep(25);
  }
}

export class ProcessGroup {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly stdout: BoundedBuffer;
  readonly stderr: BoundedBuffer;
  private readonly exitPromise: Promise<ProcessGroupExit>;
  /** 리더 프로세스의 종료(`exit`). 손자가 파이프를 쥐고 있으면 `close`보다 먼저 온다 */
  private readonly leaderExitPromise: Promise<ProcessGroupExit>;
  private exited: ProcessGroupExit | null = null;
  private leaderExited: ProcessGroupExit | null = null;
  private spawnError: Error | null = null;

  private constructor(child: ChildProcess, options: SpawnGroupOptions) {
    this.child = child;
    this.pid = child.pid ?? -1;
    this.startedAtMs = Date.now();
    this.stdout = new BoundedBuffer(options.maxOutputBytes);
    this.stderr = new BoundedBuffer(options.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => this.stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.leaderExitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.leaderExited = { exitCode: code, signal };
        resolve(this.leaderExited);
      });
    });
    this.exitPromise = new Promise((resolve) => {
      child.once("error", (error) => {
        this.spawnError = error;
        // spawn 실패는 exit 없이 close만 올 수 있다
        if (this.leaderExited === null) {
          this.leaderExited = { exitCode: null, signal: null };
        }
      });
      child.once("close", (code, signal) => {
        this.exited = { exitCode: code, signal };
        resolve(this.exited);
      });
    });
  }

  /** 새 프로세스 그룹으로 띄운다. 실행 파일이 없으면 `spawn`이 `error`를 내고 `close`가 따라온다. */
  static start(options: SpawnGroupOptions): ProcessGroup {
    const [program, ...args] = options.argv;
    if (program === undefined) throw new Error("빈 argv");
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new ProcessGroup(child, options);
  }

  get hasExited(): boolean {
    return this.exited !== null;
  }

  /** 리더가 종료됐는지 (손자가 남아 있어도 true) */
  get leaderHasExited(): boolean {
    return this.leaderExited !== null || this.spawnError !== null;
  }

  /** 리더 종료를 기다린다. spawn 실패면 close 시점에 끝난다 */
  waitForLeaderExit(): Promise<ProcessGroupExit> {
    return Promise.race([this.leaderExitPromise, this.exitPromise]);
  }

  get exit(): ProcessGroupExit | null {
    return this.exited;
  }

  get error(): Error | null {
    return this.spawnError;
  }

  waitForExit(): Promise<ProcessGroupExit> {
    return this.exitPromise;
  }

  /** 그룹 전체를 종료하고 리더의 종료를 기다린다 */
  async kill(graceMs: number): Promise<ProcessGroupExit> {
    // spawn 자체가 실패했으면(pid 없음) close가 곧 오므로 기다리기만 한다
    if (this.pid > 0) await killGroup(this.pid, graceMs);
    return this.exitPromise;
  }

  /** 리더 종료 후에도 그룹에 남은 프로세스가 있는지 */
  groupAlive(): boolean {
    return this.pid > 0 && isGroupAlive(this.pid);
  }
}
