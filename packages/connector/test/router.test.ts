import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chat,
  registerProvider,
  unregisterProvider,
  clearProviderRegistry,
  AllModelsFailed,
  BadRequestError,
  RateLimitError,
  AuthError,
  ConnectorError,
  type Message,
  type Reply,
} from "../src/index.js";

describe("router (retries and fallback)", () => {
  const origKey = process.env.NEBIUS_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpLogFile: string;
  let tmpDir: string;

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-fake-nebius-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-router-test-"));
    tmpLogFile = path.join(tmpDir, "calls.jsonl");
    process.env.CONNECTOR_LOG = tmpLogFile;
    clearProviderRegistry();
  });

  afterEach(() => {
    clearProviderRegistry();
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

  it("429 then 200 -> attempts=2 and Retry-After honoured", async () => {
    let callCount = 0;
    const delays: number[] = [];

    const fakeFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Too many requests" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "retry-after": "3",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "cmpl-retry-success",
          object: "chat.completion",
          created: 123456789,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "pong" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reply = await chat("main", [{ role: "user", content: "ping" }], {
      fetch: fakeFetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(reply.attempts).toBe(2);
    expect(reply.fallbackUsed).toBe(false);
    expect(reply.text).toBe("pong");
    expect(delays.length).toBe(1);
    // Retry-After was 3 seconds = 3000ms. computeBackoff must honour max(backoff, 3000)
    expect(delays[0]).toBeGreaterThanOrEqual(3000);

    const logLines = fs
      .readFileSync(tmpLogFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(logLines.length).toBe(2);
    expect(logLines[0]!.attempt).toBe(1);
    expect(logLines[0]!.status).toBe("retry");
    expect(logLines[0]!.error_type).toBe("RateLimitError");
    expect(logLines[0]!.http_status).toBe(429);

    expect(logLines[1]!.attempt).toBe(2);
    expect(logLines[1]!.status).toBe("ok");
    expect(logLines[1]!.http_status).toBe(200);
  });

  it("3 timeouts then fallback answers, fallbackUsed true, correct number of log lines", async () => {
    let nebiusCalls = 0;
    const delays: number[] = [];

    // Nebius fetch fails with timeouts 3 times
    const fakeFetch: typeof fetch = async () => {
      nebiusCalls++;
      throw new DOMException(`Timeout attempt ${nebiusCalls}`, "AbortError");
    };

    // Register fallback provider for meta
    registerProvider("meta", (resolved) => ({
      name: "meta",
      chat: async () => ({
        text: "Response from fallback Meta model",
        toolCalls: [],
        tokensIn: 30,
        tokensOut: 15,
        tokensCached: 0,
        raw: {},
        httpStatus: 200,
      }),
    }));

    const reply = await chat("main", [{ role: "user", content: "ping" }], {
      fetch: fakeFetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(reply.fallbackUsed).toBe(true);
    expect(reply.model).toBe("meta:muse-spark-1.3");
    expect(reply.text).toBe("Response from fallback Meta model");

    // Nebius was tried (initial + 3 retries = 4 attempts, or default maxRetries)
    // Then second Nebius model in fallback chain was also tried (or skipped if provider failed)
    // Then Meta succeeded!
    expect(reply.attempts).toBeGreaterThanOrEqual(4);

    const logLines = fs
      .readFileSync(tmpLogFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(logLines.length).toBe(reply.attempts);
    const lastLine = logLines[logLines.length - 1]!;
    expect(lastLine.status).toBe("ok");
    expect(lastLine.model).toBe("meta:muse-spark-1.3");
  });

  it("401 skips retries and same-provider models", async () => {
    let nebiusCalls = 0;

    const fakeFetch: typeof fetch = async () => {
      nebiusCalls++;
      return new Response(
        JSON.stringify({ error: { message: "Invalid Nebius API key" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    };

    let metaCalled = false;
    registerProvider("meta", (resolved) => ({
      name: "meta",
      chat: async () => {
        metaCalled = true;
        return {
          text: "Meta answered after Nebius auth failed",
          toolCalls: [],
          tokensIn: 40,
          tokensOut: 20,
          tokensCached: 0,
          raw: {},
          httpStatus: 200,
        };
      },
    }));

    const reply = await chat("main", [{ role: "user", content: "test" }], {
      fetch: fakeFetch,
      sleep: async () => {},
    });

    // Nebius was called only once: 401 skips retries on the model and skips the 2nd Nebius model in fallback
    expect(nebiusCalls).toBe(1);
    expect(metaCalled).toBe(true);
    expect(reply.fallbackUsed).toBe(true);
    expect(reply.attempts).toBe(2);
    expect(reply.model).toBe("meta:muse-spark-1.3");

    const logLines = fs
      .readFileSync(tmpLogFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(logLines.length).toBe(2);
    expect(logLines[0]!.status).toBe("fallback");
    expect(logLines[0]!.error_type).toBe("AuthError");
    expect(logLines[1]!.status).toBe("ok");
    expect(logLines[1]!.model).toBe("meta:muse-spark-1.3");
  });

  it("400 throws BadRequestError immediately with no fallback", async () => {
    let metaCalled = false;
    registerProvider("meta", () => ({
      name: "meta",
      chat: async () => {
        metaCalled = true;
        return {
          text: "Never called",
          toolCalls: [],
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          raw: {},
        };
      },
    }));

    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Bad request parameter" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      chat("main", [{ role: "user", content: "test" }], { fetch: fakeFetch }),
    ).rejects.toThrow(BadRequestError);

    expect(metaCalled).toBe(false);

    const logLines = fs
      .readFileSync(tmpLogFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(logLines.length).toBe(1);
    expect(logLines[0]!.status).toBe("failed");
    expect(logLines[0]!.error_type).toBe("BadRequestError");
  });

  it("all fail -> AllModelsFailed listing every attempt and instanceof works", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Nebius server 500" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    };

    registerProvider("meta", () => ({
      name: "meta",
      chat: async () => {
        throw new AuthError("Meta 403 Forbidden", { status: 403 });
      },
    }));

    try {
      await chat("main", [{ role: "user", content: "test" }], {
        fetch: fakeFetch,
        sleep: async () => {},
      });
      expect.fail("should have thrown AllModelsFailed");
    } catch (err) {
      expect(err).toBeInstanceOf(AllModelsFailed);
      expect(err).toBeInstanceOf(ConnectorError);

      const allFailed = err as AllModelsFailed;
      expect(allFailed.attempts.length).toBeGreaterThan(0);

      // Verify attempts structure
      for (const attempt of allFailed.attempts) {
        expect(typeof attempt.model).toBe("string");
        expect(typeof attempt.errorType).toBe("string");
        expect(typeof attempt.message).toBe("string");
      }

      // The attempt list names each failure; the subclasses keep normal instanceof behaviour
      expect(allFailed.attempts.some((a) => a.errorType === "AuthError")).toBe(true);
      const auth = new AuthError("x", { status: 401 });
      expect(auth).toBeInstanceOf(AuthError);
      expect(auth).toBeInstanceOf(ConnectorError);
      expect(auth).not.toBeInstanceOf(AllModelsFailed);
    }
  });

  it("opts.signal aborts execution immediately", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled by caller", "AbortError"));

    await expect(
      chat("main", [{ role: "user", content: "test" }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
