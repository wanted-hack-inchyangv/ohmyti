import net from "node:net";
import { describe, expect, it } from "vitest";
import { parseNetstatListeners, shadowCandidates } from "./port-guard";

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.63342        127.0.0.1.50522        ESTABLISHED
tcp4       0      0  127.0.0.1.63342        *.*                    LISTEN
tcp4       0      0  127.0.0.1.54329        *.*                    LISTEN
tcp46      0      0  *.55432                *.*                    LISTEN
tcp4       0      0  *.59648                *.*                    LISTEN
tcp6       0      0  *.59648                *.*                    LISTEN
tcp6       0      0  ::1.61000              *.*                    LISTEN
tcp46      0      0  *.4310                 *.*                    LISTEN
tcp4       0      0  127.0.0.1.5432         *.*                    LISTEN
`;

describe("port-guard", () => {
  it("netstat의 LISTEN 행만 주소·포트로 읽는다", () => {
    const listeners = parseNetstatListeners(NETSTAT);
    expect(listeners).toContainEqual({ proto: "tcp4", address: "127.0.0.1", port: 63342 });
    expect(listeners).toContainEqual({ proto: "tcp6", address: "::1", port: 61000 });
    expect(listeners).toContainEqual({ proto: "tcp46", address: "*", port: 55432 });
    // ESTABLISHED 행과 머리글은 제외
    expect(listeners.filter((l) => l.port === 63342)).toHaveLength(1);
    expect(listeners).toHaveLength(8);
  });

  it("임시 포트 범위 안에서 듀얼 스택 와일드카드가 아닌 포트만 후보로 고른다", () => {
    const ports = shadowCandidates(parseNetstatListeners(NETSTAT), { first: 49152, last: 65535 });
    // 55432는 tcp46 와일드카드라 커널이 이미 배정하지 않는다. 4310·5432는 범위 밖
    expect(ports).toEqual([54329, 59648, 61000, 63342]);
  });

  it.runIf(process.platform === "darwin")(
    "macOS에서 127.0.0.1에만 바인드된 포트에 와일드카드 바인드가 허용되고, 접속은 127.0.0.1 쪽이 받는다 (가드가 필요한 이유)",
    async () => {
      const specific = net.createServer((socket) => socket.end("specific"));
      await new Promise<void>((resolve) => specific.listen(0, "127.0.0.1", resolve));
      const port = (specific.address() as net.AddressInfo).port;
      const wildcard = net.createServer((socket) => socket.end("wildcard"));
      try {
        await new Promise<void>((resolve, reject) => {
          wildcard.once("error", reject);
          wildcard.listen(port, resolve);
        });
        const reply = await new Promise<string>((resolve, reject) => {
          const client = net.connect(port, "127.0.0.1");
          let data = "";
          client.on("data", (chunk) => (data += String(chunk)));
          client.on("end", () => resolve(data));
          client.on("error", reject);
        });
        expect(reply).toBe("specific");
      } finally {
        wildcard.close();
        specific.close();
      }
    },
  );
});
