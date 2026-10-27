import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendLog,
  computePromptSha,
  formatIsoWithOffset,
  type LogEntry,
  type Message,
} from "../src/index.js";

describe("log", () => {
  it("formats ISO date with timezone offset", () => {
    const iso = formatIsoWithOffset(new Date());
    // Should match YYYY-MM-DDTHH:mm:ss.sss+HH:MM or -HH:MM
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("computes deterministic SHA-256 for prompt messages", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Tell me a joke" },
    ];
    const sha1 = computePromptSha(messages);
    const sha2 = computePromptSha(messages);
    expect(sha1).toBe(sha2);
    expect(sha1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("appends log line with every schema field and contains no keys or message text", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-log-test-"));
    const logFile = path.join(tmpDir, "calls.jsonl");

    const fakeKey = "test-fake-secret-key-xyz987";
    const userMessageContent = "Top secret prompt text that must not appear in log file";

    const messages: Message[] = [{ role: "user", content: userMessageContent }];
    const promptSha = computePromptSha(messages);

    const entry: LogEntry = {
      ts: formatIsoWithOffset(new Date()),
      call_id: "c_01JTEST1234567890ABCDEF",
      project: "my-app",
      tag: "test-tag",
      kind: "chat",
      requested: "main",
      model: "nebius:nvidia/nemotron-3-super-120b-a12b",
      attempt: 1,
      fallback_index: 0,
      status: "ok",
      error_type: null,
      http_status: 200,
      tokens_in: 50,
      tokens_cached: 10,
      tokens_out: 25,
      cost_usd: 0.00003,
      latency_ms: 320,
      n_messages: 1,
      n_tools: 0,
      json_mode: false,
      prompt_sha: promptSha,
      error: null,
    };

    appendLog(entry, logFile);

    expect(fs.existsSync(logFile)).toBe(true);
    const rawContent = fs.readFileSync(logFile, "utf-8");

    // Must not contain secret key or message content
    expect(rawContent).not.toContain(fakeKey);
    expect(rawContent).not.toContain(userMessageContent);

    // Parse the JSON line and check every required schema field
    const lines = rawContent.trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;

    const requiredFields = [
      "ts",
      "call_id",
      "project",
      "tag",
      "kind",
      "requested",
      "model",
      "attempt",
      "fallback_index",
      "status",
      "error_type",
      "http_status",
      "tokens_in",
      "tokens_cached",
      "tokens_out",
      "cost_usd",
      "latency_ms",
      "n_messages",
      "n_tools",
      "json_mode",
      "prompt_sha",
      "error",
    ];

    for (const field of requiredFields) {
      expect(parsed).toHaveProperty(field);
    }

    expect(parsed.prompt_sha).toBe(promptSha);
    expect(parsed.call_id).toBe("c_01JTEST1234567890ABCDEF");
    expect(parsed.status).toBe("ok");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
