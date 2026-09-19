import type { MetadataRoute } from "next";
import { resolveAccessConfig } from "@/lib/auth/config";

// 배포 환경변수를 요청 시점에 읽는다 (빌드 시점 값으로 고정되지 않게)
export const dynamic = "force-dynamic";

/**
 * 비공개 배포에서는 이력서가 올라가므로 색인을 전부 막는다 (T-008).
 * `APP_ACCESS_MODE=public`인 공개 데모 배포만 색인을 허용한다.
 */
export default function robots(): MetadataRoute.Robots {
  let isPublic = false;
  try {
    const config = resolveAccessConfig(process.env);
    isPublic = !config.enabled && config.reason === "PUBLIC_MODE";
  } catch {
    // 설정 오류면 막아 둔다
  }
  return { rules: { userAgent: "*", ...(isPublic ? { allow: "/" } : { disallow: "/" }) } };
}
