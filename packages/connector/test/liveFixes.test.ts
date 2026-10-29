import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chat, BadJSONError, TruncatedError, type Message } from "../src/index.js";

function completion(message: Record<string, unknown>, finishReason: string, usage = { prompt_tokens: 40, completion_tokens: 64 }) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("live-test fixes: truncation, reasoning, usage on post-response errors", () => {
  const origKey = process.env.NEBIUS_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpDir: string;
  let logFile: string;
  const msgs: Message[] = [{ role: "user", content: "hi" }];

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-fake-nebius-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-livefix-"));
    logFile = path.join(tmpDir, "calls.jsonl");
    process.env.CONNECTOR_LOG = logFile;
  });
  afterEach(() => {
    if (origKey !== undefined) process.env.NEBIUS_API_KEY = origKey;
    else delete process.env.NEBIUS_API_KEY;
    if (origLog !== undefined) process.env.CONNECTOR_LOG = origLog;
    else delete process.env.CONNECTOR_LOG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const lastLog = () => JSON.parse(fs.readFileSync(logFile, "utf-8").trim().split("\n").at(-1)!);

  it("exposes finishReason, truncated and reasoning on a normal reply", async () => {
    const f: typeof fetch = async () => completion({ content: "Paris", reasoning_content: "capital of France" }, "stop");
    const r = await chat("main", msgs, { fetch: f, maxTokens: 64 });
    expect(r.text).toBe("Paris");
    expect(r.finishReason).toBe("stop");
    expect(r.truncated).toBe(false);
    expect(r.reasoning).toBe("capital of France");
  });

  it("marks a cut-off reply with text as truncated and logs a warning", async () => {
    const f: typeof fetch = async () => completion({ content: "Partial ans" }, "length");
    const r = await chat("main", msgs, { fetch: f, maxTokens: 64 });
    expect(r.truncated).toBe(true);
    expect(r.finishReason).toBe("length");
    expect(lastLog().warning).toMatch(/truncated/);
  });

  it("throws TruncatedError (no retry) with usage and reasoning when text is empty at max_tokens", async () => {
    let calls = 0;
    const f: typeof fetch = async () => {
      calls++;
      return completion({ content: "", reasoning: "thinking..." }, "length");
    };
    const err = await chat("main", msgs, { fetch: f, maxTokens: 64 }).catch((e) => e);
    expect(err).toBeInstanceOf(TruncatedError);
    expect(err.reasoning).toBe("thinking...");
    expect(err.usage).toEqual({ tokensIn: 40, tokensOut: 64, tokensCached: 0 });
    expect(calls).toBe(1);
    const log = lastLog();
    expect(log.error_type).toBe("TruncatedError");
    expect(log.tokens_in).toBe(40);
    expect(log.tokens_out).toBe(64);
  });

  it("keeps summed usage of both requests on BadJSONError after a failed repair", async () => {
    const f: typeof fetch = async () => completion({ content: "{not json" }, "stop", { prompt_tokens: 100, completion_tokens: 10 });
    const err = await chat("main", msgs, { fetch: f, json: true, maxTokens: 64 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadJSONError);
    expect(err.usage).toEqual({ tokensIn: 200, tokensOut: 20, tokensCached: 0 });
    const log = lastLog();
    expect(log.tokens_in).toBe(200);
    expect(log.tokens_out).toBe(20);
    expect(log.cost_usd).not.toBeNull();
  });

  it("keeps usage on BadJSONError from unparseable tool arguments", async () => {
    const f: typeof fetch = async () =>
      completion(
        { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{bad" } }] },
        "tool_calls",
      );
    const err = await chat("main", msgs, {
      fetch: f,
      maxTokens: 64,
      tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BadJSONError);
    expect(err.usage?.tokensOut).toBe(64);
  });
});
