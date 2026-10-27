import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chat,
  BadJSONError,
  AuthError,
  BadRequestError,
  RateLimitError,
  ProviderError,
  ProviderTimeout,
  type Message,
  type Tool,
} from "../src/index.js";

describe("chat", () => {
  const origKey = process.env.NEBIUS_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpLogFile: string;
  let tmpDir: string;

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-fake-nebius-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-chat-test-"));
    tmpLogFile = path.join(tmpDir, "calls.jsonl");
    process.env.CONNECTOR_LOG = tmpLogFile;
  });

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.NEBIUS_API_KEY = origKey;
    } else {
      delete process.env.NEBIUS_API_KEY;
    }
    if (origLog !== undefined) {
      process.env.CONNECTOR_LOG = origLog;
    } else {
      delete process.env.CONNECTOR_LOG;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maps text reply to Reply object with usage, cost, and latency", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mock-1",
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Paris is the capital of France." },
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

    const messages: Message[] = [{ role: "user", content: "Capital of France?" }];
    const reply = await chat("main", messages, { fetch: fakeFetch });

    expect(reply.text).toBe("Paris is the capital of France.");
    expect(reply.toolCalls).toEqual([]);
    expect(reply.tokensIn).toBe(100);
    expect(reply.tokensOut).toBe(50);
    expect(reply.tokensCached).toBe(20);
    expect(reply.fallbackUsed).toBe(false);
    expect(reply.attempts).toBe(1);
    expect(reply.callId).toMatch(/^c_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(reply.model).toBe("nebius:nvidia/nemotron-3-super-120b-a12b");
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);

    // Cost formula: uncached in = 80, cached = 20, out = 50
    // prices: in: 0.30, cached: 0.06, out: 0.90
    // cost = (80 * 0.30 + 20 * 0.06 + 50 * 0.90) / 1,000,000 = (24 + 1.2 + 45) / 1,000,000 = 70.2 / 1,000,000 = 0.0000702
    expect(reply.costUsd).toBeCloseTo(0.0000702, 7);

    // Check log line in CONNECTOR_LOG
    expect(fs.existsSync(tmpLogFile)).toBe(true);
    const logContent = fs.readFileSync(tmpLogFile, "utf-8").trim();
    const logEntry = JSON.parse(logContent) as Record<string, unknown>;
    expect(logEntry.status).toBe("ok");
    expect(logEntry.call_id).toBe(reply.callId);
    expect(logEntry.tokens_in).toBe(100);
    expect(logEntry.tokens_out).toBe(50);
    expect(logEntry.tokens_cached).toBe(20);
    expect(logEntry.cost_usd).toBeCloseTo(0.0000702, 7);
  });

  it("parses tool calls from assistant message properly", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tools",
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: JSON.stringify({ location: "Paris", units: "celsius" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      },
    ];

    const reply = await chat("main", [{ role: "user", content: "Weather in Paris?" }], {
      tools,
      fetch: fakeFetch,
    });

    expect(reply.text).toBe("");
    expect(reply.toolCalls.length).toBe(1);
    expect(reply.toolCalls[0]!.id).toBe("call_abc123");
    expect(reply.toolCalls[0]!.name).toBe("get_weather");
    expect(reply.toolCalls[0]!.arguments).toEqual({ location: "Paris", units: "celsius" });
  });

  it("throws BadJSONError with rawText when tool-call arguments contain bad JSON", async () => {
    const invalidJsonString = "{ location: 'Paris', unclosed: ";
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-bad-tool",
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_bad",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: invalidJsonString,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      chat("main", [{ role: "user", content: "Weather?" }], { fetch: fakeFetch }),
    ).rejects.toThrow(BadJSONError);

    try {
      await chat("main", [{ role: "user", content: "Weather?" }], { fetch: fakeFetch });
    } catch (err) {
      expect(err).toBeInstanceOf(BadJSONError);
      expect((err as BadJSONError).rawText).toBe(invalidJsonString);
    }
  });

  it("maps 401 error to AuthError in chat()", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Invalid authentication credentials" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      chat("main", [{ role: "user", content: "Hello" }], { fetch: fakeFetch }),
    ).rejects.toThrow(AuthError);
  });

  it("maps 400 error to BadRequestError in chat()", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Invalid parameters" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      chat("main", [{ role: "user", content: "Hello" }], { fetch: fakeFetch }),
    ).rejects.toThrow(BadRequestError);
  });

  it("maps 429 error to RateLimitError in chat()", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "retry-after": "10" },
        },
      );
    };

    try {
      await chat("main", [{ role: "user", content: "Hello" }], { fetch: fakeFetch });
      expect.fail("should have thrown RateLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(10000);
    }
  });

  it("maps 500 error to ProviderError in chat()", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Internal server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      chat("main", [{ role: "user", content: "Hello" }], { fetch: fakeFetch }),
    ).rejects.toThrow(ProviderError);
  });

  it("maps timeout to ProviderTimeout in chat()", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };

    await expect(
      chat("main", [{ role: "user", content: "Hello" }], { fetch: fakeFetch }),
    ).rejects.toThrow(ProviderTimeout);
  });
});

describe.runIf(Boolean(process.env.LIVE))("live checks", () => {
  it.skipIf(!process.env.NEBIUS_API_KEY)("calls real Nebius API", async () => {
    const reply = await chat("main", [{ role: "user", content: "Reply with the word PONG only." }]);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.tokensIn).toBeGreaterThan(0);
    expect(reply.tokensOut).toBeGreaterThan(0);
    expect(reply.costUsd).toBeGreaterThan(0);
  });
});
