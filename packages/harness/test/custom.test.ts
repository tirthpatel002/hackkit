import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { customPlugin, loadExport } from "../src/checks/builtin.js";
import { ConfigError } from "../src/errors.js";
import { stubChat } from "../src/runner.js";
import type { Case, CaseOutput, CheckContext } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeContext(output: CaseOutput, projectDir: string): CheckContext {
  const dummyCase: Case = {
    id: "custom-test-case",
    input: {},
    check: [],
  };
  return {
    case: dummyCase,
    output,
    chat: stubChat,
    signal: new AbortController().signal,
    projectDir,
  };
}

describe("custom check", () => {
  it("loads a .ts export and calls it returning CheckResult", async () => {
    const fixturePath = path.resolve(__dirname, "fixtures/fake-checks.ts");
    const fn = await loadExport(`${fixturePath}:samplePassCheck`);
    expect(typeof fn).toBe("function");

    const ctx = makeContext({ text: "this will pass" }, __dirname);
    const result = await customPlugin.run(
      { fn: `${fixturePath}:samplePassCheck` },
      ctx,
    );
    expect(result.type).toBe("custom");
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("Contains pass");
  });

  it("handles a boolean return from custom check", async () => {
    const fixturePath = path.resolve(__dirname, "fixtures/fake-checks.ts");
    const ctx = makeContext({ text: "valid" }, __dirname);
    const result = await customPlugin.run(
      { fn: `${fixturePath}:sampleBooleanCheck` },
      ctx,
    );
    expect(result.passed).toBe(true);

    const failCtx = makeContext({ text: "invalid" }, __dirname);
    const failResult = await customPlugin.run(
      { fn: `${fixturePath}:sampleBooleanCheck` },
      failCtx,
    );
    expect(failResult.passed).toBe(false);
  });

  it("throws ConfigError on bad file path", async () => {
    await expect(
      loadExport("nonexistent/path/check.ts:myFn", __dirname),
    ).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on missing export", async () => {
    const fixturePath = path.resolve(__dirname, "fixtures/fake-checks.ts");
    await expect(
      loadExport(`${fixturePath}:nonExistentExportFunction`, __dirname),
    ).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError when export is not a function", async () => {
    const fixturePath = path.resolve(__dirname, "fixtures/fake-checks.ts");
    await expect(
      loadExport(`${fixturePath}:notAFunction`, __dirname),
    ).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on invalid fn spec format", async () => {
    await expect(loadExport("invalid-no-colon-spec", __dirname)).rejects.toThrow(
      ConfigError,
    );
  });
});
