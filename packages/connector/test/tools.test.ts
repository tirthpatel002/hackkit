import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chat,
  BadJSONError,
  type Message,
  type Tool,
} from "../src/index.js";

describe("tools and json mode", () => {
  const origKey = process.env.NEBIUS_API_KEY;
  const origLog = process.env.CONNECTOR_LOG;
  let tmpDir: string;
  let tmpLogFile: string;

  beforeEach(() => {
    process.env.NEBIUS_API_KEY = "test-fake-nebius-key";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-tools-test-"));
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

  it("passes tools schema through in request body and parses tool calls in Reply", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const fakeFetch: typeof fetch = async (_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tools-test",
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
                    id: "call_calc_99",
                    type: "function",
                    function: {
                      name: "calculator",
                      arguments: JSON.stringify({ expression: "40 + 2" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 45, completion_tokens: 15, total_tokens: 60 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "calculator",
          description: "Perform calculation",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        },
      },
    ];

    const reply = await chat("main", [{ role: "user", content: "Calculate 40 + 2" }], {
      tools,
      fetch: fakeFetch,
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.tools).toBeDefined();
    expect(Array.isArray(capturedBody!.tools)).toBe(true);

    expect(reply.text).toBe("");
    expect(reply.toolCalls.length).toBe(1);
    expect(reply.toolCalls[0]!.id).toBe("call_calc_99");
    expect(reply.toolCalls[0]!.name).toBe("calculator");
    expect(reply.toolCalls[0]!.arguments).toEqual({ expression: "40 + 2" });
  });

  it("throws BadJSONError with rawText on bad tool-call arguments", async () => {
    const rawBadJson = "{ broken json: 123 ";
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-bad-args",
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
                      name: "test_fn",
                      arguments: rawBadJson,
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

    try {
      await chat("main", [{ role: "user", content: "Test" }], { fetch: fakeFetch });
      expect.fail("Should have thrown BadJSONError");
    } catch (err) {
      expect(err).toBeInstanceOf(BadJSONError);
      expect((err as BadJSONError).rawText).toBe(rawBadJson);
    }
  });

  it("sends response_format json_object when json: true and parses reply.json()", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const fakeFetch: typeof fetch = async (_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-json-mode",
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"city": "Paris", "population": 2161000}',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reply = await chat("main", [{ role: "user", content: "Paris info as JSON" }], {
      json: true,
      fetch: fakeFetch,
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.response_format).toEqual({ type: "json_object" });

    expect(reply.text).toBe('{"city": "Paris", "population": 2161000}');
    const data = reply.json<{ city: string; population: number }>();
    expect(data.city).toBe("Paris");
    expect(data.population).toBe(2161000);
  });

  it("performs one repair call when initial json: true reply is invalid JSON and succeeds if repaired", async () => {
    let callCount = 0;
    const capturedBodies: Record<string, unknown>[] = [];

    const fakeFetch: typeof fetch = async (_url, init) => {
      callCount++;
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      }

      if (callCount === 1) {
        // Return bad JSON on first call
        return new Response(
          JSON.stringify({
            id: "chatcmpl-try-1",
            object: "chat.completion",
            created: 1677652288,
            model: "nvidia/nemotron-3-super-120b-a12b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "I forgot JSON syntax: { key: missing quotes }",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Return valid JSON on repair call
      return new Response(
        JSON.stringify({
          id: "chatcmpl-try-2",
          object: "chat.completion",
          created: 1677652289,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"key": "fixed quotes"}',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 35, completion_tokens: 8, total_tokens: 43 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reply = await chat("main", [{ role: "user", content: "Send JSON" }], {
      json: true,
      fetch: fakeFetch,
    });

    expect(callCount).toBe(2);
    expect(capturedBodies.length).toBe(2);

    // Verify repair prompt appended the parse error
    const repairMessages = capturedBodies[1]!.messages as { role: string; content: string }[];
    expect(repairMessages.length).toBe(3); // user prompt + assistant bad reply + user error note
    expect(repairMessages[1]!.content).toBe("I forgot JSON syntax: { key: missing quotes }");
    expect(repairMessages[2]!.content).toContain("The response was not valid JSON:");

    expect(reply.text).toBe('{"key": "fixed quotes"}');
    expect(reply.json()).toEqual({ key: "fixed quotes" });
  });

  it("throws BadJSONError with rawText when repair call also returns invalid JSON", async () => {
    let callCount = 0;

    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          id: `chatcmpl-bad-${callCount}`,
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `Bad JSON attempt ${callCount}`,
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      await chat("main", [{ role: "user", content: "Send JSON" }], {
        json: true,
        fetch: fakeFetch,
      });
      expect.fail("Should have thrown BadJSONError");
    } catch (err) {
      expect(callCount).toBe(2); // exactly one repair attempt
      expect(err).toBeInstanceOf(BadJSONError);
      expect((err as BadJSONError).rawText).toBe("Bad JSON attempt 2");
    }
  });

  it("reply.json() throws BadJSONError with rawText on invalid JSON when json: true was not requested", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-plain-text",
          object: "chat.completion",
          created: 1677652288,
          model: "nvidia/nemotron-3-super-120b-a12b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Just plain text, not JSON" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reply = await chat("main", [{ role: "user", content: "Hi" }], { fetch: fakeFetch });
    expect(() => reply.json()).toThrow(BadJSONError);

    try {
      reply.json();
    } catch (err) {
      expect(err).toBeInstanceOf(BadJSONError);
      expect((err as BadJSONError).rawText).toBe("Just plain text, not JSON");
    }
  });
});
