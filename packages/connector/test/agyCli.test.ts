import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chat,
  flatten,
  parseBestEffortJson,
  parseConfig,
  setConfig,
  ConfigError,
  BadRequestError,
  ProviderError,
  BadJSONError,
  type Message,
  type Tool,
} from "../src/index.js";

const FAKE_AGY_PATH = path.resolve(
  import.meta.dirname,
  "fixtures/fake-agy.mjs",
);

describe("agy-cli provider", () => {
  const origLog = process.env.CONNECTOR_LOG;
  let tmpDir: string;
  let tmpLogFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-agy-test-"));
    tmpLogFile = path.join(tmpDir, "calls.jsonl");
    process.env.CONNECTOR_LOG = tmpLogFile;

    delete process.env.FAKE_AGY_EXIT_CODE;
    delete process.env.FAKE_AGY_STDERR;
    delete process.env.FAKE_AGY_SLEEP_MS;
    delete process.env.FAKE_AGY_OUTPUT;

    const testConfig = parseConfig({
      providers: {
        "agy-cli": {
          bin: FAKE_AGY_PATH,
          wrapper: [],
          default_model: "gemini-3.8-flash-high",
          timeout_ms: 300000,
          max_retries: 0,
        },
      },
    });
    setConfig(testConfig);
  });

  afterEach(() => {
    delete process.env.FAKE_AGY_EXIT_CODE;
    delete process.env.FAKE_AGY_STDERR;
    delete process.env.FAKE_AGY_SLEEP_MS;
    delete process.env.FAKE_AGY_OUTPUT;

    if (origLog !== undefined) {
      process.env.CONNECTOR_LOG = origLog;
    } else {
      delete process.env.CONNECTOR_LOG;
    }
    setConfig(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("flatten()", () => {
    it("formats system, user, assistant and tool messages properly", () => {
      const messages: Message[] = [
        { role: "system", content: "System instructions" },
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "It is 4." },
        { role: "tool", tool_call_id: "call_abc", content: "4" },
      ];

      const flattened = flatten(messages);
      expect(flattened).toBe(
        "SYSTEM:\nSystem instructions\n\nUSER:\nWhat is 2+2?\n\nASSISTANT:\nIt is 4.\n\nTOOL RESULT call_abc:\n4",
      );
    });

    it("handles null message content cleanly", () => {
      const messages: Message[] = [
        { role: "assistant", content: null },
      ];
      expect(flatten(messages)).toBe("ASSISTANT:\n");
    });
  });

  describe("CLI arguments & model resolution", () => {
    it("passes exact args array and uses default model when called as agy-cli", async () => {
      const reply = await chat("agy-cli", [{ role: "user", content: "Hello agy" }]);

      expect(reply.model).toBe("agy-cli:gemini-3.8-flash-high");
      expect(reply.toolCalls).toEqual([]);
      expect(reply.tokensIn).toBeNull();
      expect(reply.tokensOut).toBeNull();
      expect(reply.tokensCached).toBeNull();
      expect(reply.costUsd).toBeNull();
      expect(reply.fallbackUsed).toBe(false);
      expect(reply.attempts).toBe(1);

      const argv = JSON.parse(reply.text) as string[];
      expect(argv).toEqual([
        "--dangerously-skip-permissions",
        "-p",
        "USER:\nHello agy",
        "--model",
        "gemini-3.8-flash-high",
      ]);
    });

    it("uses explicit model when passed as agy-cli:<model>", async () => {
      const reply = await chat("agy-cli:gemini-3.8-pro", [{ role: "user", content: "Hello" }]);

      expect(reply.model).toBe("agy-cli:gemini-3.8-pro");
      const argv = JSON.parse(reply.text) as string[];
      expect(argv).toEqual([
        "--dangerously-skip-permissions",
        "-p",
        "USER:\nHello",
        "--model",
        "gemini-3.8-pro",
      ]);
    });

    it("prepends wrapper arguments correctly", async () => {
      const testConfig = parseConfig({
        providers: {
          "agy-cli": {
            bin: FAKE_AGY_PATH,
            wrapper: ["env", "TEST_VAR=1"],
            default_model: "gemini-3.8-flash-high",
          },
        },
      });
      setConfig(testConfig);

      const reply = await chat("agy-cli", [{ role: "user", content: "Test wrapper" }]);
      const argv = JSON.parse(reply.text) as string[];
      expect(argv).toEqual([
        "--dangerously-skip-permissions",
        "-p",
        "USER:\nTest wrapper",
        "--model",
        "gemini-3.8-flash-high",
      ]);
    });

    it("passes prompts containing quotes, semicolons, and dollar signs as one unchanged argument", async () => {
      const specialPrompt = 'Quotes: "single" \'double\'; Semicolon; $ENV_VAR and `backticks`';
      const reply = await chat("agy-cli", [{ role: "user", content: specialPrompt }]);

      const argv = JSON.parse(reply.text) as string[];
      expect(argv[2]).toBe(`USER:\n${specialPrompt}`);
    });
  });

  describe("Error handling", () => {
    it("throws BadRequestError if tools are provided", async () => {
      const tools: Tool[] = [
        {
          type: "function",
          function: { name: "test_tool", parameters: {} },
        },
      ];

      await expect(
        chat("agy-cli", [{ role: "user", content: "Hi" }], { tools }),
      ).rejects.toThrow(BadRequestError);

      try {
        await chat("agy-cli", [{ role: "user", content: "Hi" }], { tools });
        expect.fail("Should have thrown BadRequestError");
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as BadRequestError).message).toContain("tools are not supported on agy-cli");
      }
    });

    it("throws ProviderError with exitCode and last 4 KB stderr on non-zero exit", async () => {
      process.env.FAKE_AGY_EXIT_CODE = "2";
      const hugeStderr = "prefix_info\n" + "x".repeat(5000) + "\nerror_suffix";
      process.env.FAKE_AGY_STDERR = hugeStderr;

      try {
        await chat("agy-cli", [{ role: "user", content: "Fail" }]);
        expect.fail("Should have thrown ProviderError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        const pe = err as ProviderError;
        expect(pe.exitCode).toBe(2);
        expect(pe.stderr).toBeDefined();
        // Checked last 4 KB
        expect(Buffer.byteLength(pe.stderr!, "utf-8")).toBeLessThanOrEqual(4096);
        expect(pe.stderr!).toContain("error_suffix");
        expect(pe.stderr!).not.toContain("prefix_info");
      }
    });

    it("throws ProviderError('timeout') and kills child on timeout", async () => {
      process.env.FAKE_AGY_SLEEP_MS = "5000";

      try {
        await chat("agy-cli", [{ role: "user", content: "Sleep" }], { timeoutMs: 50 });
        expect.fail("Should have timed out");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).message).toBe("timeout");
      }
    });

    it("throws ProviderError('timeout') when AbortSignal is triggered", async () => {
      process.env.FAKE_AGY_SLEEP_MS = "5000";
      const controller = new AbortController();

      setTimeout(() => controller.abort(), 30);

      try {
        await chat("agy-cli", [{ role: "user", content: "Sleep" }], { signal: controller.signal });
        expect.fail("Should have aborted");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).message).toBe("timeout");
      }
    });

    it("throws ConfigError when binary is not found (ENOENT)", async () => {
      const nonExistentPath = "/path/that/does/not/exist/at/all/agy-fake";
      const testConfig = parseConfig({
        providers: {
          "agy-cli": {
            bin: nonExistentPath,
          },
        },
      });
      setConfig(testConfig);

      try {
        await chat("agy-cli", [{ role: "user", content: "Test" }]);
        expect.fail("Should have thrown ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toContain(`agy not found at ${nonExistentPath}`);
      }
    });
  });

  describe("JSON mode and best-effort parsing", () => {
    it("adds instruction line to prompt when json: true", async () => {
      const reply = await chat("agy-cli", [{ role: "user", content: "List items" }], { json: true });

      const argv = JSON.parse(reply.text) as string[];
      expect(argv[2]).toBe(
        "USER:\nList items\n\nReply with one JSON value only, no other text.",
      );
    });

    it("parses whole clean JSON via reply.json()", async () => {
      process.env.FAKE_AGY_OUTPUT = '{"status": "ok", "count": 5}';

      const reply = await chat("agy-cli", [{ role: "user", content: "Get JSON" }], { json: true });
      expect(reply.json()).toEqual({ status: "ok", count: 5 });
    });

    it("parses markdown code-fenced output via reply.json()", async () => {
      process.env.FAKE_AGY_OUTPUT = '```json\n{\n  "title": "Fenced Output",\n  "version": 1\n}\n```';

      const reply = await chat("agy-cli", [{ role: "user", content: "Get JSON" }], { json: true });
      expect(reply.json()).toEqual({ title: "Fenced Output", version: 1 });
    });

    it("parses prose-wrapped output from first brace/bracket to last via reply.json()", async () => {
      process.env.FAKE_AGY_OUTPUT =
        'Sure! Here is the response you requested:\n{"items": ["apple", "banana"]}\nHope that helps!';

      const reply = await chat("agy-cli", [{ role: "user", content: "Get JSON" }], { json: true });
      expect(reply.json()).toEqual({ items: ["apple", "banana"] });
    });

    it("parses array candidate from prose-wrapped output via reply.json()", async () => {
      process.env.FAKE_AGY_OUTPUT =
        'Here is the list: [1, 2, 3] as requested.';

      const reply = await chat("agy-cli", [{ role: "user", content: "Get JSON" }], { json: true });
      expect(reply.json()).toEqual([1, 2, 3]);
    });

    it("throws BadJSONError with rawText if output cannot be parsed as JSON", async () => {
      process.env.FAKE_AGY_OUTPUT = "I cannot provide JSON for this prompt.";

      const reply = await chat("agy-cli", [{ role: "user", content: "Get JSON" }], { json: true });
      expect(() => reply.json()).toThrow(BadJSONError);

      try {
        reply.json();
      } catch (err) {
        expect(err).toBeInstanceOf(BadJSONError);
        expect((err as BadJSONError).rawText).toBe("I cannot provide JSON for this prompt.");
      }
    });

    it("parseBestEffortJson standalone helper function works", () => {
      expect(parseBestEffortJson('{"a": 1}', "test-model")).toEqual({ a: 1 });
      expect(parseBestEffortJson('```\n{"b": 2}\n```', "test-model")).toEqual({ b: 2 });
      expect(parseBestEffortJson('Leading text {"c": 3} trailing', "test-model")).toEqual({ c: 3 });
      expect(() => parseBestEffortJson("not json", "test-model")).toThrow(BadJSONError);
    });
  });

  describe("Logging", () => {
    it("writes log line with null tokens, null cost, null http_status, exit_code 0 and latency", async () => {
      const reply = await chat("agy-cli", [{ role: "user", content: "Hello" }]);

      expect(fs.existsSync(tmpLogFile)).toBe(true);
      const logContent = fs.readFileSync(tmpLogFile, "utf-8").trim();
      const entry = JSON.parse(logContent) as Record<string, unknown>;

      expect(entry.call_id).toBe(reply.callId);
      expect(entry.model).toBe("agy-cli:gemini-3.8-flash-high");
      expect(entry.status).toBe("ok");
      expect(entry.http_status).toBeNull();
      expect(entry.exit_code).toBe(0);
      expect(entry.tokens_in).toBeNull();
      expect(entry.tokens_out).toBeNull();
      expect(entry.tokens_cached).toBeNull();
      expect(entry.cost_usd).toBeNull();
      expect(typeof entry.latency_ms).toBe("number");
      expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });
});

describe.runIf(Boolean(process.env.LIVE))("live agy-cli checks", () => {
  it("calls real local agy CLI and returns text", async () => {
    const reply = await chat("agy-cli", [{ role: "user", content: "Reply with the single word PONG." }]);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.model).toContain("agy-cli");
    expect(reply.tokensIn).toBeNull();
    expect(reply.costUsd).toBeNull();
  });
});
