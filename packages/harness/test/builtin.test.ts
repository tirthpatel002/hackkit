import { describe, expect, it } from "vitest";
import { exactPlugin, containsPlugin } from "../src/checks/builtin.js";
import { resolveField, stubChat } from "../src/runner.js";
import type { Case, CaseOutput, CheckContext } from "../src/types.js";

function makeContext(
  output: CaseOutput,
  caseExpect?: unknown,
): CheckContext {
  const dummyCase: Case = {
    id: "test-case",
    input: {},
    expect: caseExpect,
    check: [],
  };
  return {
    case: dummyCase,
    output,
    chat: stubChat,
    signal: new AbortController().signal,
  };
}

describe("exact check", () => {
  it("matches identical text", () => {
    const ctx = makeContext({ text: "hello" });
    const res = exactPlugin.run({ value: "hello" }, ctx);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  it("trims whitespace from target and expected", () => {
    const ctx = makeContext({ text: "  hello \n" });
    const res = exactPlugin.run({ value: "hello  " }, ctx);
    expect(res.passed).toBe(true);
  });

  it("is case-insensitive by default", () => {
    const ctx = makeContext({ text: "HELLO" });
    const res = exactPlugin.run({ value: "hello" }, ctx);
    expect(res.passed).toBe(true);
  });

  it("respects case_sensitive: true", () => {
    const ctx = makeContext({ text: "HELLO" });
    const res = exactPlugin.run({ value: "hello", case_sensitive: true }, ctx);
    expect(res.passed).toBe(false);
    expect(res.reason).toContain("Expected exact match");
  });

  it("falls back to case.expect if value is omitted", () => {
    const ctx = makeContext({ text: "expected value" }, "expected value");
    const res = exactPlugin.run({}, ctx);
    expect(res.passed).toBe(true);
  });
});

describe("contains check", () => {
  it("handles a single string value", () => {
    const ctx = makeContext({ text: "The capital of France is Paris." });
    const res = containsPlugin.run({ value: "Paris" }, ctx);
    expect(res.passed).toBe(true);
  });

  it("checks all_of: true requires all strings to be present", () => {
    const ctx = makeContext({ text: "Apples and oranges in the basket" });
    const passRes = containsPlugin.run({ value: ["Apples", "oranges"], all_of: true }, ctx);
    expect(passRes.passed).toBe(true);

    const failRes = containsPlugin.run({ value: ["Apples", "bananas"], all_of: true }, ctx);
    expect(failRes.passed).toBe(false);
    expect(failRes.reason).toContain("Missing required substring(s)");
  });

  it("checks all_of: false passes if any string is present", () => {
    const ctx = makeContext({ text: "The capital of France is Paris." });
    const passRes = containsPlugin.run(
      { value: ["London", "Paris", "Berlin"], all_of: false },
      ctx,
    );
    expect(passRes.passed).toBe(true);

    const failRes = containsPlugin.run(
      { value: ["London", "Berlin", "Tokyo"], all_of: false },
      ctx,
    );
    expect(failRes.passed).toBe(false);
    expect(failRes.reason).toContain("Did not contain any of");
  });

  it("is case-insensitive by default and case-sensitive when requested", () => {
    const ctx = makeContext({ text: "the quick brown fox" });
    const passRes = containsPlugin.run({ value: "FOX" }, ctx);
    expect(passRes.passed).toBe(true);

    const failRes = containsPlugin.run({ value: "FOX", case_sensitive: true }, ctx);
    expect(failRes.passed).toBe(false);
  });
});

describe("field resolution", () => {
  it("returns text by default", () => {
    const out: CaseOutput = { text: "direct text" };
    expect(resolveField(out, "text")).toBe("direct text");
    expect(resolveField(out)).toBe("direct text");
  });

  it("resolves nested dotted fields", () => {
    const out: CaseOutput = {
      text: "main output",
      data: {
        sentences: "1",
        meta: {
          count: 42,
        },
      },
    };
    expect(resolveField(out, "data.sentences")).toBe("1");
    expect(resolveField(out, "data.meta.count")).toBe(42);
    expect(resolveField(out, "data.nonexistent")).toBeUndefined();
  });
});
