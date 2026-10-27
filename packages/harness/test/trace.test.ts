import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  toolCalledPlugin,
  toolNotCalledPlugin,
  orderPlugin,
  maxStepsPlugin,
  finalOutputPlugin,
} from "../src/checks/trace.js";
import { ConfigError } from "../src/errors.js";
import { resetRegistry } from "../src/registry.js";
import { run, stubChat } from "../src/runner.js";
import type { AgentTrace, Case, CaseOutput, CheckContext } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoProjectDir = path.resolve(__dirname, "../examples/echo");

function makeContext(trace?: AgentTrace): CheckContext {
  const dummyCase: Case = {
    id: "trace-test-case",
    kind: "trace",
    input: {},
    check: [],
  };
  const finalOutput: CaseOutput = trace?.final ?? { text: "default final text" };
  return {
    case: dummyCase,
    output: finalOutput,
    trace,
    chat: stubChat,
    signal: new AbortController().signal,
  };
}

describe("trace checks", () => {
  const fixtureTrace: AgentTrace = {
    steps: [
      { seq: 1, type: "step", input: "init task" },
      {
        seq: 2,
        type: "tool_call",
        tool: "search",
        input: { query: "population of Pune", limit: 10 },
      },
      { seq: 3, type: "tool_result", tool: "search", output: "3124458" },
      {
        seq: 4,
        type: "tool_call",
        tool: "calculator",
        input: { expr: "3124458 / 1000" },
      },
      { seq: 5, type: "tool_result", tool: "calculator", output: "3124.458" },
      {
        seq: 6,
        type: "tool_call",
        tool: "search",
        input: { query: "validation" },
      },
      { seq: 7, type: "step", output: "Population is about 3124 thousand" },
    ],
    final: {
      text: "Population is about 3124 thousand",
      data: { answer: "3124" },
    },
  };

  describe("toolCalled", () => {
    it("passes when tool is called at least min times", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolCalledPlugin.run({ tool: "search", min: 1 }, ctx);
      expect(res.passed).toBe(true);
      expect(res.score).toBe(1);
    });

    it("passes when tool count is within min and max", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolCalledPlugin.run({ tool: "search", min: 1, max: 2 }, ctx);
      expect(res.passed).toBe(true);
    });

    it("fails when tool count is below min", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolCalledPlugin.run({ tool: "search", min: 3 }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain('Tool "search" called 2 times, expected at least 3');
    });

    it("fails when tool count exceeds max", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolCalledPlugin.run({ tool: "search", min: 1, max: 1 }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain('Tool "search" called 2 times, expected between 1 and 1');
    });

    it("matches args subset correctly", () => {
      const ctx = makeContext(fixtureTrace);
      const passRes = toolCalledPlugin.run(
        { tool: "search", args: { query: "population of Pune" } },
        ctx,
      );
      expect(passRes.passed).toBe(true);

      const failRes = toolCalledPlugin.run(
        { tool: "search", args: { query: "nonexistent query" } },
        ctx,
      );
      expect(failRes.passed).toBe(false);
    });

    it("returns false if trace is missing", () => {
      const ctx = makeContext(undefined);
      const res = toolCalledPlugin.run({ tool: "search" }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("requires agent trace");
    });
  });

  describe("toolNotCalled", () => {
    it("passes when tool is never called", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolNotCalledPlugin.run({ tool: "delete_file" }, ctx);
      expect(res.passed).toBe(true);
      expect(res.score).toBe(1);
    });

    it("fails when tool was called", () => {
      const ctx = makeContext(fixtureTrace);
      const res = toolNotCalledPlugin.run({ tool: "search" }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain('Tool "search" was called in trace');
    });

    it("returns false if trace is missing", () => {
      const ctx = makeContext(undefined);
      const res = toolNotCalledPlugin.run({ tool: "search" }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("requires agent trace");
    });
  });

  describe("order", () => {
    it("passes when tools appear in subsequence order (strict: false)", () => {
      const ctx = makeContext(fixtureTrace);
      // Tools in trace: search, calculator, search
      const res = orderPlugin.run({ tools: ["search", "calculator"] }, ctx);
      expect(res.passed).toBe(true);
      expect(res.score).toBe(1);
    });

    it("fails when tools appear out of order (strict: false)", () => {
      const ctx = makeContext(fixtureTrace);
      const res = orderPlugin.run({ tools: ["calculator", "unknown_tool"] }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("did not appear in order");
    });

    it("passes strict: true when tools appear adjacently", () => {
      const ctx = makeContext(fixtureTrace);
      // search then calculator are adjacent in called tools sequence
      const res = orderPlugin.run(
        { tools: ["search", "calculator"], strict: true },
        ctx,
      );
      expect(res.passed).toBe(true);
    });

    it("fails strict: true when tools are not adjacent", () => {
      const traceWithGap: AgentTrace = {
        steps: [
          { seq: 1, type: "tool_call", tool: "search" },
          { seq: 2, type: "tool_call", tool: "extra" },
          { seq: 3, type: "tool_call", tool: "calculator" },
        ],
        final: { text: "done" },
      };
      const ctx = makeContext(traceWithGap);
      const res = orderPlugin.run(
        { tools: ["search", "calculator"], strict: true },
        ctx,
      );
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("did not appear adjacently in order");
    });

    it("returns false if trace is missing", () => {
      const ctx = makeContext(undefined);
      const res = orderPlugin.run({ tools: ["search"] }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("requires agent trace");
    });
  });

  describe("maxSteps", () => {
    it("passes when step count is within limit", () => {
      const ctx = makeContext(fixtureTrace);
      // 7 steps <= 8
      const res = maxStepsPlugin.run({ value: 8 }, ctx);
      expect(res.passed).toBe(true);
      expect(res.score).toBe(1);
    });

    it("passes when step count equals value", () => {
      const ctx = makeContext(fixtureTrace);
      const res = maxStepsPlugin.run({ value: 7 }, ctx);
      expect(res.passed).toBe(true);
    });

    it("fails when step count exceeds value", () => {
      const ctx = makeContext(fixtureTrace);
      const res = maxStepsPlugin.run({ value: 5 }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("Expected at most 5 steps, got 7");
    });

    it("returns false if trace is missing", () => {
      const ctx = makeContext(undefined);
      const res = maxStepsPlugin.run({ value: 5 }, ctx);
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("requires agent trace");
    });
  });

  describe("finalOutput", () => {
    it("runs nested check on trace.final text", async () => {
      resetRegistry();
      const ctx = makeContext(fixtureTrace);
      const res = await finalOutputPlugin.run(
        { check: { type: "contains", value: "thousand" } },
        ctx,
      );
      expect(res.passed).toBe(true);
      expect(res.type).toBe("finalOutput");
    });

    it("fails when nested check fails", async () => {
      resetRegistry();
      const ctx = makeContext(fixtureTrace);
      const res = await finalOutputPlugin.run(
        { check: { type: "contains", value: "million" } },
        ctx,
      );
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("Missing required substring(s)");
    });

    it("supports field resolution and negation on nested check", async () => {
      resetRegistry();
      const ctx = makeContext(fixtureTrace);
      const res = await finalOutputPlugin.run(
        {
          check: {
            type: "exact",
            field: "data.answer",
            value: "3124",
          },
        },
        ctx,
      );
      expect(res.passed).toBe(true);

      const negateRes = await finalOutputPlugin.run(
        {
          check: {
            type: "exact",
            field: "data.answer",
            value: "9999",
            negate: true,
          },
        },
        ctx,
      );
      expect(negateRes.passed).toBe(true);
    });

    it("throws ConfigError if nested check is trace-only", async () => {
      resetRegistry();
      const ctx = makeContext(fixtureTrace);
      await expect(
        finalOutputPlugin.run(
          { check: { type: "toolCalled", tool: "search" } },
          ctx,
        ),
      ).rejects.toThrow(ConfigError);
    });

    it("returns false if trace is missing", async () => {
      resetRegistry();
      const ctx = makeContext(undefined);
      const res = await finalOutputPlugin.run(
        { check: { type: "contains", value: "test" } },
        ctx,
      );
      expect(res.passed).toBe(false);
      expect(res.reason).toContain("requires agent trace");
    });
  });

  describe("trace case runner integration", () => {
    it("runs trace case in echo project returning kind: trace and step count", async () => {
      process.env.HARNESS_FAKE_JUDGE = "1";
      try {
        const results = await run(echoProjectDir, {
          casesFile: "cases/trace.yaml",
          concurrency: 1,
        });
        expect(results.cases).toHaveLength(1);
        const traceCase = results.cases[0];
        expect(traceCase?.id).toBe("agent-001-search-then-compute");
        expect(traceCase?.kind).toBe("trace");
        expect(traceCase?.passed).toBe(true);
        expect(traceCase?.steps).toBe(6);
        expect(traceCase?.checks).toHaveLength(5);
        expect(traceCase?.checks.every((c) => c.passed)).toBe(true);
      } finally {
        delete process.env.HARNESS_FAKE_JUDGE;
      }
    });
  });
});
