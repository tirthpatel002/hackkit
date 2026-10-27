import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chat,
  ConfigError,
  MetaProvider,
  META_DEFAULT_BASE_URL,
  META_DEFAULT_KEY_ENV,
  resolveModel,
  parseConfig,
  type Message,
  type Tool,
} from "../src/index.js";

describe("Meta provider", () => {
  const origKey = process.env.META_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpDir: string;
  let tmpLogFile: string;

  beforeEach(() => {
    process.env.META_API_KEY = "test-fake-meta-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-meta-test-"));
    tmpLogFile = path.join(tmpDir, "calls.jsonl");
    process.env.CONNECTOR_LOG = tmpLogFile;
  });

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.META_API_KEY = origKey;
    } else {
      delete process.env.META_API_KEY;
    }
    if (origLog !== undefined) {
      process.env.CONNECTOR_LOG = origLog;
    } else {
      delete process.env.CONNECTOR_LOG;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("has correct defaults for base URL, keyEnv and timeout", () => {
    expect(META_DEFAULT_BASE_URL).toBe("https://api.meta.ai/v1");
    expect(META_DEFAULT_KEY_ENV).toBe("META_API_KEY");

    const provider = new MetaProvider();
    expect(provider.name).toBe("meta");
  });

  it("strips stop and n from requests sent to Meta", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const fakeFetch: typeof fetch = async (_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-meta-1",
          object: "chat.completion",
          created: 1677652288,
          model: "muse-spark-1.3",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Meta Muse Spark reply" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const messages: Message[] = [{ role: "user", content: "Hello Meta" }];
    const reply = await chat("meta:muse-spark-1.3", messages, {
      fetch: fakeFetch,
      stop: ["STOP_TOKEN"],
      n: 2,
    });

    expect(reply.text).toBe("Meta Muse Spark reply");
    expect(reply.model).toBe("meta:muse-spark-1.3");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.model).toBe("muse-spark-1.3");
    expect(capturedBody!.stop).toBeUndefined();
    expect(capturedBody!.n).toBeUndefined();
    expect(capturedBody!.logit_bias).toBeUndefined();
    expect(capturedBody!.reasoning_effort).toBeUndefined();
  });

  it("throws ConfigError naming META_API_KEY when key is missing", async () => {
    delete process.env.META_API_KEY;

    await expect(
      chat("meta:muse-spark-1.3", [{ role: "user", content: "Hello" }]),
    ).rejects.toThrow(ConfigError);

    try {
      await chat("meta:muse-spark-1.3", [{ role: "user", content: "Hello" }]);
      expect.fail("Should have thrown ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("META_API_KEY");
    }
  });

  it("resolves model aliases pointing to meta", () => {
    const config = parseConfig({
      aliases: {
        spark: "meta:muse-spark-1.3",
        wonder: "meta:muse-wonder-1.0",
      },
    });

    const resolvedSpark = resolveModel("spark", config);
    expect(resolvedSpark.provider).toBe("meta");
    expect(resolvedSpark.modelId).toBe("muse-spark-1.3");
    expect(resolvedSpark.fullName).toBe("meta:muse-spark-1.3");

    const resolvedDirect = resolveModel("meta:muse-spark-1.2", config);
    expect(resolvedDirect.provider).toBe("meta");
    expect(resolvedDirect.modelId).toBe("muse-spark-1.2");
  });

  it("gives same result for YAML-shaped and TS-shaped config", () => {
    const yamlConfig = parseConfig({
      providers: {
        meta: {
          base_url: "https://api.meta.ai/v1",
          key_env: "META_API_KEY",
          timeout_ms: 120000,
        },
      },
      aliases: {
        main: "meta:muse-spark-1.3",
      },
    });

    const tsConfig = parseConfig({
      providers: {
        meta: {
          baseUrl: "https://api.meta.ai/v1",
          keyEnv: "META_API_KEY",
          timeoutMs: 120000,
        },
      },
      aliases: {
        main: "meta:muse-spark-1.3",
      },
    });

    expect(yamlConfig.providers.meta).toEqual(tsConfig.providers.meta);
    expect(yamlConfig.aliases.main).toBe(tsConfig.aliases.main);
  });

  it("calculates cost accurately for Meta models including reasoning tokens", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-meta-cost",
          object: "chat.completion",
          created: 1677652288,
          model: "muse-spark-1.3",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Thought and answer." },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50, // counts reasoning tokens
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reply = await chat("meta:muse-spark-1.3", [{ role: "user", content: "Compute" }], {
      fetch: fakeFetch,
    });

    // meta:muse-spark-1.3: in: 1.25, cached: 0.15, out: 4.25
    // uncached in = 80 -> 80 * 1.25 = 100
    // cached in = 20 -> 20 * 0.15 = 3
    // out = 50 -> 50 * 4.25 = 212.5
    // total = (100 + 3 + 212.5) / 1,000,000 = 0.0003155
    expect(reply.costUsd).toBeCloseTo(0.0003155, 7);
  });
});

describe.runIf(Boolean(process.env.LIVE))("live meta checks", () => {
  it.skipIf(!process.env.META_API_KEY)("calls live Meta API with tool call", async () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Get the current time",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const reply = await chat("meta:muse-spark-1.3", [
      { role: "user", content: "What is the time? Use the get_time tool." },
    ], { tools });

    expect(reply.attempts).toBe(1);
    expect(reply.toolCalls.length).toBeGreaterThan(0);
    expect(reply.toolCalls[0]!.name).toBe("get_time");
  });
});
