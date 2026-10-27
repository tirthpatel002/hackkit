import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoProjectDir = path.resolve(__dirname, "../examples/echo");

describe("cli end-to-end", () => {
  beforeAll(() => {
    process.env.HARNESS_FAKE_JUDGE = "1";
  });

  afterAll(() => {
    delete process.env.HARNESS_FAKE_JUDGE;
  });
  it("runs examples/echo and returns exit code 0", async () => {
    delete process.env.ECHO_PLANT_FAIL;
    const code = await main(["run", echoProjectDir, "--concurrency", "4"]);
    expect(code).toBe(0);
  });

  it("runs examples/echo with ECHO_PLANT_FAIL=1 and returns exit code 1", async () => {
    process.env.ECHO_PLANT_FAIL = "1";
    try {
      const code = await main(["run", echoProjectDir, "--concurrency", "4"]);
      expect(code).toBe(1);
    } finally {
      delete process.env.ECHO_PLANT_FAIL;
    }
  });

  it("lists cases with harness list command and returns exit code 0", async () => {
    const code = await main(["list", echoProjectDir]);
    expect(code).toBe(0);
  });

  it("lists checks with harness list-checks command and returns exit code 0", async () => {
    const code = await main(["list-checks", echoProjectDir]);
    expect(code).toBe(0);
  });

  it("returns exit code 2 when no command is provided", async () => {
    const code = await main([]);
    expect(code).toBe(2);
  });
});
