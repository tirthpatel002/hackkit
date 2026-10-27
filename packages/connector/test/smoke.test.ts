import { describe, expect, it } from "vitest";
import { runSmoke, main } from "../src/smoke.js";

describe("smoke script", () => {
  it("smoke with all keys unset prints skips and exits 0 (run its main function with injected env, no network)", async () => {
    const logs: string[] = [];
    const out = {
      log: (msg: string) => {
        logs.push(msg);
      },
    };

    const emptyEnv: Record<string, string | undefined> = {
      NEBIUS_API_KEY: undefined,
      META_API_KEY: undefined,
      QLOO_API_KEY: undefined,
    };

    const code = await runSmoke([], emptyEnv, out);

    expect(code).toBe(0);
    expect(logs.length).toBe(5);

    // Verify skip messages
    expect(logs.some((l) => l.includes("nebius") && l.includes("skip (no NEBIUS_API_KEY)"))).toBe(true);
    expect(logs.some((l) => l.includes("embed") && l.includes("skip (no NEBIUS_API_KEY)"))).toBe(true);
    expect(logs.some((l) => l.includes("meta") && l.includes("skip (no META_API_KEY)"))).toBe(true);
    expect(logs.some((l) => l.includes("agy-cli") && l.includes("skip"))).toBe(true);
    expect(logs.some((l) => l.includes("qloo") && l.includes("skip (no QLOO_API_KEY)"))).toBe(true);
  });

  it("filters checks with --only <name>", async () => {
    const logs: string[] = [];
    const out = {
      log: (msg: string) => {
        logs.push(msg);
      },
    };

    const emptyEnv: Record<string, string | undefined> = {
      NEBIUS_API_KEY: undefined,
      META_API_KEY: undefined,
      QLOO_API_KEY: undefined,
    };

    const code = await runSmoke(["--only", "nebius-chat"], emptyEnv, out);

    expect(code).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("nebius");
    expect(logs[0]).toContain("chat");
    expect(logs[0]).toContain("skip (no NEBIUS_API_KEY)");
  });

  it("filters checks with --only qloo", async () => {
    const logs: string[] = [];
    const out = {
      log: (msg: string) => {
        logs.push(msg);
      },
    };

    const emptyEnv: Record<string, string | undefined> = {
      NEBIUS_API_KEY: undefined,
      META_API_KEY: undefined,
      QLOO_API_KEY: undefined,
    };

    const code = await runSmoke(["--only=qloo"], emptyEnv, out);

    expect(code).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("qloo");
    expect(logs[0]).toContain("search");
    expect(logs[0]).toContain("skip (no QLOO_API_KEY)");
  });

  it("returns exit code 1 if --only filter matches no checks", async () => {
    const logs: string[] = [];
    const out = {
      log: (msg: string) => {
        logs.push(msg);
      },
    };

    const code = await runSmoke(["--only", "nonexistent-provider"], {}, out);
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("No checks matched"))).toBe(true);
  });

  it("main export aliases runSmoke", () => {
    expect(main).toBe(runSmoke);
  });
});
