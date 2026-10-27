import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/errors.js";
import { getCheck, resetRegistry } from "../src/registry.js";
import {
  JudgeOptionsSchema,
  JudgeReplySchema,
  clearRubricCache,
  judgePlugin,
} from "../src/checks/judge.js";
import type { Case, CaseOutput, CheckContext } from "../src/types.js";
import type { Reply } from "@hackkit/connector";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoProjectDir = path.resolve(__dirname, "../examples/echo");

function makeFakeReply(data: {
  text: string;
  costUsd?: number;
  jsonObj?: unknown;
}): Reply {
  return {
    text: data.text,
    toolCalls: [],
    tokensIn: 50,
    tokensOut: 20,
    costUsd: data.costUsd ?? 0.0005,
    latencyMs: 10,
    model: "judge",
    tokensCached: 0,
    fallbackUsed: false,
    attempts: 1,
    callId: "c_fake_judge",
    json: <T = unknown>() =>
      (data.jsonObj !== undefined
        ? data.jsonObj
        : JSON.parse(data.text)) as unknown as T,
    raw: {},
  };
}

describe("judge check", () => {
  beforeEach(() => {
    resetRegistry();
    clearRubricCache();
  });

  it("is registered as built-in check type 'judge'", () => {
    const plugin = getCheck("judge");
    expect(plugin).toBeDefined();
    expect(plugin?.type).toBe("judge");
  });

  it("validates JudgeOptionsSchema", () => {
    const valid = JudgeOptionsSchema.parse({
      rubric: "matches-expected",
    });
    expect(valid.rubric).toBe("matches-expected");
    expect(valid.pass_score).toBe(4);
    expect(valid.model).toBe("judge");

    const custom = JudgeOptionsSchema.parse({
      rubric: "matches-expected",
      pass_score: 3,
      model: "custom-model",
    });
    expect(custom.pass_score).toBe(3);
    expect(custom.model).toBe("custom-model");

    expect(() => JudgeOptionsSchema.parse({})).toThrow();
  });

  it("throws ConfigError when rubrics file or rubric does not exist", async () => {
    const fakeCase: Case = {
      id: "case-1",
      input: { q: "test" },
      expect: "test",
      check: [{ type: "judge", rubric: "non-existent" }],
    };
    const fakeOutput: CaseOutput = { text: "test" };
    const fakeChat = vi.fn();

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    await expect(
      judgePlugin.run({ rubric: "non-existent-rubric" }, ctx),
    ).rejects.toThrow(ConfigError);

    const badCtx: CheckContext = {
      ...ctx,
      projectDir: "/non/existent/dir",
    };
    await expect(
      judgePlugin.run({ rubric: "matches-expected" }, badCtx),
    ).rejects.toThrow(ConfigError);
  });

  it("passes when score >= pass_score (default 4)", async () => {
    const fakeCase: Case = {
      id: "case-1",
      input: { question: "Why is the sky blue?" },
      expect: "Sunlight scatters off air molecules and blue light scatters most.",
      check: [{ type: "judge", rubric: "matches-expected", pass_score: 4 }],
    };
    const fakeOutput: CaseOutput = {
      text: "Sunlight scatters off air molecules, with blue scattering the most.",
    };

    const replyObj = {
      score: 5,
      reason: "Answer matches expected meaning completely.",
      failed_criteria: [],
    };

    const fakeChat = vi.fn().mockResolvedValue(
      makeFakeReply({
        text: JSON.stringify(replyObj),
        costUsd: 0.0004,
        jsonObj: replyObj,
      }),
    );

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    const result = await judgePlugin.run(
      { rubric: "matches-expected", pass_score: 4, model: "judge" },
      ctx,
    );

    expect(result.type).toBe("judge");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(5);
    expect(result.reason).toBe("Answer matches expected meaning completely.");
    expect(result.costUsd).toBe(0.0004);

    expect(fakeChat).toHaveBeenCalledTimes(1);
    const [model, messages, opts] = fakeChat.mock.calls[0]!;
    expect(model).toBe("judge");
    expect(opts).toMatchObject({
      temperature: 0,
      tag: "judge",
      json: true,
    });
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("RUBRIC:");
    expect(messages[1].content).toContain("INPUT:");
    expect(messages[1].content).toContain("EXPECTED:");
    expect(messages[1].content).toContain("ANSWER:");
  });

  it("fails when score < pass_score", async () => {
    const fakeCase: Case = {
      id: "case-2",
      input: { question: "What is 2+2?" },
      expect: "4",
      check: [{ type: "judge", rubric: "matches-expected", pass_score: 4 }],
    };
    const fakeOutput: CaseOutput = { text: "5" };

    const replyObj = {
      score: 2,
      reason: "Incorrect arithmetic result.",
      failed_criteria: [0],
    };

    const fakeChat = vi.fn().mockResolvedValue(
      makeFakeReply({
        text: JSON.stringify(replyObj),
        costUsd: 0.0003,
        jsonObj: replyObj,
      }),
    );

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    const result = await judgePlugin.run(
      { rubric: "matches-expected", pass_score: 4, model: "judge" },
      ctx,
    );

    expect(result.type).toBe("judge");
    expect(result.passed).toBe(false);
    expect(result.score).toBe(2);
    expect(result.reason).toBe("Incorrect arithmetic result.");
    expect(result.costUsd).toBe(0.0003);
  });

  it("fails with 'judge_unparseable' when response is unparseable twice", async () => {
    const fakeCase: Case = {
      id: "case-3",
      input: { text: "test" },
      expect: "test",
      check: [{ type: "judge", rubric: "matches-expected" }],
    };
    const fakeOutput: CaseOutput = { text: "test output" };

    const badReply = {
      text: "Sorry, I am unable to grade this as JSON.",
      costUsd: 0.0002,
      json: () => {
        throw new Error("SyntaxError: Unexpected token");
      },
    };

    const fakeChat = vi
      .fn()
      .mockResolvedValueOnce(badReply)
      .mockResolvedValueOnce(badReply);

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    const result = await judgePlugin.run(
      { rubric: "matches-expected", pass_score: 4, model: "judge" },
      ctx,
    );

    expect(result.type).toBe("judge");
    expect(result.passed).toBe(false);
    expect(result.score).toBeNull();
    expect(result.reason).toBe("judge_unparseable");
    // Cost accumulated across 2 attempts
    expect(result.costUsd).toBeCloseTo(0.0004);
    expect(fakeChat).toHaveBeenCalledTimes(2);
  });

  it("succeeds on second try if first try was unparseable", async () => {
    const fakeCase: Case = {
      id: "case-4",
      input: { text: "test" },
      expect: "test",
      check: [{ type: "judge", rubric: "matches-expected" }],
    };
    const fakeOutput: CaseOutput = { text: "test output" };

    const badReply = {
      text: "Not JSON",
      costUsd: 0.0002,
      json: () => {
        throw new Error("Bad JSON");
      },
    };

    const goodReplyObj = {
      score: 4,
      reason: "Correct on retry",
      failed_criteria: [],
    };
    const goodReply = makeFakeReply({
      text: JSON.stringify(goodReplyObj),
      costUsd: 0.0003,
      jsonObj: goodReplyObj,
    });

    const fakeChat = vi
      .fn()
      .mockResolvedValueOnce(badReply)
      .mockResolvedValueOnce(goodReply);

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    const result = await judgePlugin.run(
      { rubric: "matches-expected", pass_score: 4, model: "judge" },
      ctx,
    );

    expect(result.type).toBe("judge");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(4);
    expect(result.reason).toBe("Correct on retry");
    // Cost accumulated from both tries (0.0002 + 0.0003)
    expect(result.costUsd).toBeCloseTo(0.0005);
    expect(fakeChat).toHaveBeenCalledTimes(2);
  });

  it("respects custom pass_score (e.g. 3)", async () => {
    const fakeCase: Case = {
      id: "case-5",
      input: { text: "partial" },
      expect: "complete",
      check: [{ type: "judge", rubric: "matches-expected", pass_score: 3 }],
    };
    const fakeOutput: CaseOutput = { text: "partial" };

    const replyObj = {
      score: 3,
      reason: "Partly correct.",
      failed_criteria: [1],
    };

    const fakeChat = vi.fn().mockResolvedValue(
      makeFakeReply({
        text: JSON.stringify(replyObj),
        costUsd: 0.0001,
        jsonObj: replyObj,
      }),
    );

    const ctx: CheckContext = {
      case: fakeCase,
      output: fakeOutput,
      chat: fakeChat as any,
      signal: new AbortController().signal,
      projectDir: echoProjectDir,
    };

    const result = await judgePlugin.run(
      { rubric: "matches-expected", pass_score: 3, model: "judge" },
      ctx,
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(3);
  });
});
