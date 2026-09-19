/**
 * macOS 임시 포트 가드 (T-607).
 *
 * 샘플 제출 테스트는 supertest(`request(app)`)로 요청마다 `listen(0)`(와일드카드 `::`)을 열고
 * `127.0.0.1:<port>`로 접속한다. macOS는 TCP 임시 포트를 순차로 배정하며(`net.inet.tcp.randomize_ports: 0`),
 * 다른 프로세스가 같은 포트를 `127.0.0.1`에만 바인드해 두었어도 와일드카드 바인드를 허용한다.
 * 이때 접속은 더 구체적인 주소의 소켓(다른 프로세스)이 받으므로, 샘플 테스트가 404·ECONNRESET을 받고
 * 제출 테스트가 FAILED가 된다. 테스트 실행이 임시 포트를 많이 쓸수록 배정 카운터가 그 포트를 자주 지난다.
 *
 * 가드는 테스트 시작 시점에 임시 포트 범위에서 LISTEN 중인 포트를 찾아, 와일드카드로 바인드할 수 있는
 * 포트(= 다른 프로세스가 특정 주소에만 바인드한 포트)를 테스트가 끝날 때까지 와일드카드로 점유한다.
 * 그러면 커널이 그 포트를 다른 `listen(0)`에 배정하지 않는다. 제품 코드와 러너 동작은 바꾸지 않는다.
 * Linux(CI·Railway)는 이런 바인드를 EADDRINUSE로 거부하므로 가드가 필요 없다.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";

export interface PortListener {
  proto: string;
  address: string;
  port: number;
}

/** `netstat -an -p tcp` 출력에서 LISTEN 행의 로컬 주소를 읽는다 (예: `tcp4 0 0 127.0.0.1.54329 *.* LISTEN`) */
export function parseNetstatListeners(output: string): PortListener[] {
  const listeners: PortListener[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || fields.at(-1) !== "LISTEN" || !fields[0]!.startsWith("tcp")) continue;
    const local = fields[3]!;
    const dot = local.lastIndexOf(".");
    const port = Number(local.slice(dot + 1));
    if (dot <= 0 || !Number.isInteger(port)) continue;
    listeners.push({ proto: fields[0]!, address: local.slice(0, dot), port });
  }
  return listeners;
}

/** 와일드카드 바인드로 점유할 후보: 임시 포트 범위 안에서 듀얼 스택 와일드카드(`tcp46 *`)가 아닌 LISTEN 포트 */
export function shadowCandidates(
  listeners: readonly PortListener[],
  range: { first: number; last: number },
): number[] {
  const dualStack = new Set(
    listeners.filter((l) => l.proto === "tcp46" && l.address === "*").map((l) => l.port),
  );
  const ports = listeners
    .filter((l) => l.port >= range.first && l.port <= range.last && !dualStack.has(l.port))
    .map((l) => l.port);
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** supertest와 같은 방식(호스트 생략)으로 바인드를 시도한다. 이미 와일드카드가 있으면 null */
function occupy(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, () => {
      server.unref();
      resolve(server);
    });
  });
}

function sysctlInt(name: string, fallback: number): number {
  try {
    const value = Number(execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim());
    return Number.isInteger(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** macOS에서만 가드를 건다. 해제 함수를 돌려준다. 실패는 테스트를 막지 않고 경고만 남긴다 */
export async function guardShadowedPorts(): Promise<() => Promise<void>> {
  if (process.platform !== "darwin") return () => Promise.resolve();
  let servers: net.Server[] = [];
  try {
    const listeners = parseNetstatListeners(
      execFileSync("netstat", ["-an", "-p", "tcp"], { encoding: "utf8" }),
    );
    const range = {
      first: sysctlInt("net.inet.ip.portrange.first", 49152),
      last: sysctlInt("net.inet.ip.portrange.last", 65535),
    };
    const occupied = await Promise.all(shadowCandidates(listeners, range).map(occupy));
    servers = occupied.filter((s): s is net.Server => s !== null);
    if (servers.length > 0) {
      const ports = servers.map((s) => (s.address() as net.AddressInfo).port).join(", ");
      console.log(
        `[port-guard] 다른 프로세스가 127.0.0.1 등에만 바인드한 임시 포트를 점유: ${ports}`,
      );
    }
  } catch (error) {
    console.warn(`[port-guard] 포트 가드를 걸지 못했습니다: ${(error as Error).message}`);
  }
  return async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  };
}
