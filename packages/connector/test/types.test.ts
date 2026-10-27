import { describe, expect, it } from "vitest";
import { createReply, BadJSONError, type Message, type Tool } from "../src/index.js";

describe("types", () => {
  it("creates a Reply object with json helper", () => {
    const reply = createReply({
      text: '{"greeting":"hello","count":42}',
      toolCalls: [],
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 0,
      costUsd: 0.0001,
      latencyMs: 150,
      model: "nebius:nvidia/nemotron-3-super-120b-a12b",
      fallbackUsed: false,
      attempts: 1,
      callId: "c_0123456789ABCDEF",
      raw: {},
    });

    expect(reply.text).toBe('{"greeting":"hello","count":42}');
    expect(reply.toolCalls).toEqual([]);
    expect(reply.tokensIn).toBe(10);
    expect(reply.tokensOut).toBe(20);
    expect(reply.tokensCached).toBe(0);
    expect(reply.costUsd).toBe(0.0001);
    expect(reply.latencyMs).toBe(150);
    expect(reply.model).toBe("nebius:nvidia/nemotron-3-super-120b-a12b");
    expect(reply.fallbackUsed).toBe(false);
    expect(reply.attempts).toBe(1);
    expect(reply.callId).toBe("c_0123456789ABCDEF");

    const parsed = reply.json<{ greeting: string; count: number }>();
    expect(parsed).toEqual({ greeting: "hello", count: 42 });
  });

  it("throws BadJSONError with rawText when json() fails on bad JSON", () => {
    const raw = "Not a valid JSON { string";
    const reply = createReply({
      text: raw,
      toolCalls: [],
      tokensIn: 5,
      tokensOut: 5,
      tokensCached: 0,
      costUsd: 0.00005,
      latencyMs: 100,
      model: "nebius:nvidia/nemotron-3-super-120b-a12b",
      fallbackUsed: false,
      attempts: 1,
      callId: "c_0123456789ABCDEF",
      raw: {},
    });

    expect(() => reply.json()).toThrow(BadJSONError);
    try {
      reply.json();
    } catch (err) {
      expect(err).toBeInstanceOf(BadJSONError);
      const badJson = err as BadJSONError;
      expect(badJson.rawText).toBe(raw);
      expect(badJson.opts.model).toBe("nebius:nvidia/nemotron-3-super-120b-a12b");
    }
  });

  it("supports typed Message and Tool shapes", () => {
    const msg: Message = {
      role: "user",
      content: "Hello world",
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello world");

    const tool: Tool = {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    };
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("get_weather");
  });
});
