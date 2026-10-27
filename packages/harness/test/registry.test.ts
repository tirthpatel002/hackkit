import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { getCheck, listChecks, registerCheck, resetRegistry } from "../src/registry.js";
import { z } from "zod";

describe("registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  it("has built-ins registered at start", () => {
    const checks = listChecks();
    expect(checks).toContain("exact");
    expect(checks).toContain("contains");
    expect(checks).toContain("custom");

    expect(getCheck("exact")).toBeDefined();
    expect(getCheck("contains")).toBeDefined();
    expect(getCheck("custom")).toBeDefined();
  });

  it("registerCheck adds a new check plugin", () => {
    registerCheck({
      type: "myPlugin",
      options: z.object({ value: z.string() }),
      run: (opts, ctx) => ({
        type: "myPlugin",
        passed: ctx.output.text === opts.value,
        score: null,
        reason: "",
      }),
    });

    expect(getCheck("myPlugin")).toBeDefined();
    expect(listChecks()).toContain("myPlugin");
  });

  it("throws ConfigError when registering a type that is already taken", () => {
    expect(() => {
      registerCheck({
        type: "exact",
        run: () => ({ type: "exact", passed: true, score: 1, reason: "" }),
      });
    }).toThrow(ConfigError);
  });

  it("throws ConfigError for invalid plugin definition", () => {
    expect(() => {
      registerCheck({} as any);
    }).toThrow(ConfigError);
  });
});
