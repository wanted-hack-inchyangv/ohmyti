import { describe, expect, it } from "vitest";
import { FsArtifactStore } from "@ohmyti/storage";
import { createRunnerFromEnv } from "./factory";
import { LocalProcessRunner } from "./local/local-runner";
import { VercelSandboxRunner } from "./vercel/vercel-runner";

const artifactStore = new FsArtifactStore({ root: "/tmp/ohmyti-factory-test" });

describe("createRunnerFromEnv", () => {
  it("기본은 local이고 SANDBOX_RUNNER=vercel이면 VercelSandboxRunner다", () => {
    const local = createRunnerFromEnv({ TEMPLATE_ROOT: "./templates" }, { artifactStore });
    expect(local).toBeInstanceOf(LocalProcessRunner);
    expect(local.kind).toBe("local");

    const vercel = createRunnerFromEnv(
      {
        TEMPLATE_ROOT: "./templates",
        SANDBOX_RUNNER: "vercel",
        VERCEL_TOKEN: "t",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "prj",
      },
      { artifactStore },
    );
    expect(vercel).toBeInstanceOf(VercelSandboxRunner);
    expect(vercel.kind).toBe("vercel");
  });

  it("vercel인데 자격증명이 없으면 실패하고, 모르는 값은 거부한다", () => {
    expect(() =>
      createRunnerFromEnv({ TEMPLATE_ROOT: "x", SANDBOX_RUNNER: "vercel" }, { artifactStore }),
    ).toThrow(/VERCEL_TOKEN/);
    expect(() =>
      createRunnerFromEnv({ TEMPLATE_ROOT: "x", SANDBOX_RUNNER: "docker" }, { artifactStore }),
    ).toThrow(/local \| vercel/);
  });
});
