import { describe, expect, it } from "vitest";
import { BlockedCommandError } from "../runner";
import {
  assertCommandAllowed,
  assertScriptsAllowed,
  blockedReason,
  requestedScriptName,
  scriptBlockedReason,
} from "./commands";

describe("blockedReason", () => {
  it.each([
    [["npm", "install"]],
    [["npm", "i"]],
    [["npm", "ci"]],
    [["npm", "install", "left-pad"]],
    [["npm", "--no-audit", "install"]],
    [["npm", "update"]],
    [["npm", "link"]],
    [["npm", "exec", "cowsay"]],
    [["pnpm", "add", "left-pad"]],
    [["pnpm", "install"]],
    [["pnpm", "dlx", "cowsay"]],
    [["yarn", "add", "x"]],
    [["yarn", "install"]],
    [["bun", "add", "x"]],
    [["npx", "cowsay"]],
    [["pnpx", "cowsay"]],
    [["bunx", "cowsay"]],
    [["corepack", "enable"]],
    [["/usr/local/bin/npm", "install"]],
    [["npm.cmd", "install"]],
    [["NPM", "INSTALL"]],
  ])("%j은 거부된다", (argv) => {
    expect(blockedReason(argv)).not.toBeNull();
    expect(() => assertCommandAllowed(argv)).toThrow(BlockedCommandError);
  });

  it.each([
    [["npm", "start"]],
    [["npm", "test"]],
    [["npm", "run", "build"]],
    [["npm", "run-script", "lint", "--silent"]],
    [["npm", "--silent", "start"]],
    [["node", "index.js"]],
    [["tsx", "src/server.ts"]],
    [["vitest", "run"]],
    [["pnpm", "test"]],
    [["yarn", "start"]],
  ])("%j은 허용된다", (argv) => {
    expect(blockedReason(argv)).toBeNull();
    expect(() => assertCommandAllowed(argv)).not.toThrow();
  });

  it("빈 명령과 하위 명령 없는 npm은 거부된다", () => {
    expect(blockedReason([])).not.toBeNull();
    expect(blockedReason([""])).not.toBeNull();
    expect(blockedReason(["npm"])).not.toBeNull();
  });
});

describe("scriptBlockedReason", () => {
  it.each([
    "npm install && node server.js",
    "node build.js; npm ci",
    "pnpm add left-pad || true",
    "FOO=bar npm install",
    "npx tsx src/server.ts",
    "yarn",
    "yarn && node x",
    "corepack pnpm install",
  ])("%j에서 설치 명령을 찾는다", (script) => {
    expect(scriptBlockedReason(script)).not.toBeNull();
  });

  it.each(["tsx src/server.ts", "node dist/index.js", "vitest run", "npm run build && node x", ""])(
    "%j은 허용된다",
    (script) => {
      expect(scriptBlockedReason(script)).toBeNull();
    },
  );
});

describe("assertScriptsAllowed", () => {
  const scripts = {
    prestart: "npm ci",
    start: "node server.js",
    test: "vitest run",
    posttest: "npx cowsay done",
    build: "tsc",
  };

  it("npm start는 prestart의 설치 명령 때문에 거부된다", () => {
    expect(() => assertScriptsAllowed(["npm", "start"], scripts)).toThrow(/prestart/);
  });

  it("npm test는 posttest의 npx 때문에 거부된다", () => {
    expect(() => assertScriptsAllowed(["npm", "t"], scripts)).toThrow(/posttest/);
  });

  it("npm run build는 허용된다", () => {
    expect(() => assertScriptsAllowed(["npm", "run", "build"], scripts)).not.toThrow();
  });

  it("스크립트가 없거나 npm이 아니면 검사하지 않는다", () => {
    expect(() => assertScriptsAllowed(["npm", "start"], undefined)).not.toThrow();
    expect(() => assertScriptsAllowed(["node", "x.js"], scripts)).not.toThrow();
  });
});

describe("requestedScriptName", () => {
  it.each([
    [["start"], "start"],
    [["test"], "test"],
    [["t"], "test"],
    [["run", "build"], "build"],
    [["run-script", "lint"], "lint"],
    [["--silent", "run", "dev"], "dev"],
    [["view", "express"], undefined],
    [[], undefined],
  ])("%j → %s", (args, expected) => {
    expect(requestedScriptName(args)).toBe(expected);
  });
});
