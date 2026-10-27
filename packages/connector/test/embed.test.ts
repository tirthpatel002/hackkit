import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { embed, AuthError, BadRequestError } from "../src/index.js";

describe("embed", () => {
  const origKey = process.env.NEBIUS_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpLogFile: string;
  let tmpDir: string;

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-fake-nebius-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-embed-test-"));
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

  it("embed returns vectors with dim and logs", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: [0.1, 0.2, 0.3, 0.4],
            },
            {
              object: "embedding",
              index: 1,
              embedding: [0.5, 0.6, 0.7, 0.8],
            },
          ],
          model: "Qwen/Qwen3-Embedding-8B",
          usage: { prompt_tokens: 16, total_tokens: 16 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await embed(["first text", "second text"], { fetch: fakeFetch });

    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);
    expect(res[0]).toBeInstanceOf(Float32Array);
    expect(res[1]).toBeInstanceOf(Float32Array);
    expect(Array.from(res[0]!)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
    ]);
    expect(res.dim).toBe(4);
    expect(res.dimensions).toBe(4);
    expect(res.tokensIn).toBe(16);
    expect(res.costUsd).toBeCloseTo((16 * 0.01) / 1_000_000, 8);

    // Verify log line
    expect(fs.existsSync(tmpLogFile)).toBe(true);
    const logLines = fs
      .readFileSync(tmpLogFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(logLines.length).toBe(1);
    const log = logLines[0]!;
    expect(log.kind).toBe("embed");
    expect(log.requested).toBe("embed");
    expect(log.model).toBe("nebius:Qwen/Qwen3-Embedding-8B");
    expect(log.status).toBe("ok");
    expect(log.tokens_in).toBe(16);
    expect(log.n_messages).toBe(2);
    expect(typeof log.prompt_sha).toBe("string");
  });

  it("handles batching when texts exceed 64 items", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async (url, init) => {
      callCount++;
      const body = JSON.parse(init?.body as string) as { input: string[] };
      const data = body.input.map((txt, idx) => ({
        object: "embedding",
        index: idx,
        embedding: [0.1, 0.2, 0.3],
      }));
      return new Response(
        JSON.stringify({
          object: "list",
          data,
          usage: { prompt_tokens: body.input.length * 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const texts = Array.from({ length: 80 }, (_, i) => `text-${i}`);
    const res = await embed(texts, { fetch: fakeFetch });

    expect(callCount).toBe(2); // 64 in batch 1, 16 in batch 2
    expect(res.length).toBe(80);
    expect(res.dim).toBe(3);
    expect(res.tokensIn).toBe(160);
  });

  it("retries on 429 with backoff and succeeds", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const fakeFetch: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Rate limit" } }),
          { status: 429, headers: { "Content-Type": "application/json", "retry-after": "1" } },
        );
      }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [1, 2] }],
          usage: { prompt_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await embed(["hello"], {
      fetch: fakeFetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(attempts).toBe(2);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(res.length).toBe(1);
    expect(res.dim).toBe(2);
  });

  it("throws AuthError immediately on 401 without retry", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { message: "Invalid key" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(embed(["text"], { fetch: fakeFetch })).rejects.toThrow(AuthError);
    expect(callCount).toBe(1);
  });

  it("throws BadRequestError immediately on 400 without retry", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { message: "Bad dimensions" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(embed(["text"], { fetch: fakeFetch })).rejects.toThrow(BadRequestError);
    expect(callCount).toBe(1);
  });

  it("returns empty result on empty input array without calling network", async () => {
    let called = false;
    const fakeFetch: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    const res = await embed([], { fetch: fakeFetch });
    expect(called).toBe(false);
    expect(res.length).toBe(0);
    expect(res.dim).toBe(0);
    expect(res.tokensIn).toBe(0);
    expect(res.costUsd).toBe(0);
  });
});
