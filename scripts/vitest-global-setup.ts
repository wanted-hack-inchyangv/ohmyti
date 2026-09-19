/**
 * Vitest globalSetup: 저장소 루트의 .env.local·.env를 읽어 테스트 워커에 전달하고,
 * macOS에서는 다른 프로세스가 특정 주소에만 바인드한 임시 포트를 테스트가 끝날 때까지 점유한다 (T-607, `port-guard.ts`).
 */
import "./load-env";
import { guardShadowedPorts } from "./port-guard";

export default async function setup(): Promise<() => Promise<void>> {
  return guardShadowedPorts();
}
