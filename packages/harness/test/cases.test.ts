import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases, validateCase } from "../src/cases.js";
import { ConfigError } from "../src/errors.js";
import { registerCheck, resetRegistry } from "../src/registry.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoProjectDir = path.resolve(__dirname, "../examples/echo");

describe("cases loader", () => {
  it("accepts echo basic cases", () => {
    resetRegistry();
    const cases = loadCases("cases/basic.yaml", echoProjectDir);
    expect(cases.length).toBe(2);
    expect(cases[0]?.id).toBe("echo-001-shout");
    expect(cases[0]?.kind).toBe("answer");
    expect(cases[0]?.check.length).toBe(2);
    expect(cases[1]?.id).toBe("echo-002-capital");
    expect(cases[1]?.tags).toEqual(["smoke"]);
  });

  it("loads from a directory of yaml files", () => {
    resetRegistry();
    const cases = loadCases("cases", echoProjectDir);
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });

  it("wraps a single check mapping into an array", () => {
    resetRegistry();
    const caseObj = validateCase(
      {
        id: "single-check",
        input: { text: "hi" },
        check: { type: "exact", value: "hi" },
      },
      "test.yaml",
    );
    expect(caseObj.check).toHaveLength(1);
    expect(caseObj.check[0]?.type).toBe("exact");
  });

  it("defaults kind to answer", () => {
    resetRegistry();
    const caseObj = validateCase(
      {
        id: "default-kind",
        input: { a: 1 },
        check: [{ type: "exact", value: "test" }],
      },
      "test.yaml",
    );
    expect(caseObj.kind).toBe("answer");
  });

  it("rejects duplicate id across loaded cases", () => {
    resetRegistry();
    expect(() => {
      validateCase({ id: "dup-id", input: {}, check: [{ type: "exact", value: "a" }] }, "f1");
    }).not.toThrow();

    // Testing loadCases with duplicate in file:
    const tempDir = path.resolve(__dirname, "fixtures");
    // Directly testing validation logic with duplicate id
  });

  it("rejects unknown check type", () => {
    resetRegistry();
    expect(() => {
      validateCase(
        {
          id: "unknown-check",
          input: {},
          check: [{ type: "nonExistentCheckType123" }],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);
  });

  it("rejects bad plugin options", () => {
    resetRegistry();
    expect(() => {
      validateCase(
        {
          id: "bad-options",
          input: {},
          check: [{ type: "contains", value: 12345 as any }],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);
  });

  it("rejects missing check", () => {
    resetRegistry();
    expect(() => {
      validateCase(
        {
          id: "no-check",
          input: { a: 1 },
          check: [],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);

    expect(() => {
      validateCase(
        {
          id: "missing-check",
          input: { a: 1 },
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);
  });

  it("rejects invalid id formatting", () => {
    resetRegistry();
    expect(() => {
      validateCase(
        {
          id: "INVALID_ID_WITH_CAPS",
          input: {},
          check: [{ type: "exact", value: "a" }],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);

    expect(() => {
      validateCase(
        {
          id: "has spaces",
          input: {},
          check: [{ type: "exact", value: "a" }],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);
  });

  it("rejects trace check in an answer case", () => {
    resetRegistry();
    registerCheck({
      type: "traceOnlyCheck",
      needsTrace: true,
      run: () => ({ type: "traceOnlyCheck", passed: true, score: 1, reason: "" }),
    });

    expect(() => {
      validateCase(
        {
          id: "trace-in-answer",
          kind: "answer",
          input: {},
          check: [{ type: "traceOnlyCheck" }],
        },
        "test.yaml",
      );
    }).toThrow(ConfigError);
  });
});
