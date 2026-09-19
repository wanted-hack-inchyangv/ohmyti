import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ohmyti/core", "@ohmyti/db", "@ohmyti/storage"],
  experimental: {
    // 이력서 PDF 업로드(T-206, 상한 10 MiB) + multipart 오버헤드. MAX_RESUME_BYTES보다 커야 한다
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
