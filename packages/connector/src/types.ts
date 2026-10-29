import { BadJSONError } from "./errors.js";

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string | null;
  tool_call_id?: string | undefined;
  tool_calls?: unknown[] | undefined;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Reply {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  latencyMs: number;
  model: string;
  tokensCached: number | null;
  fallbackUsed: boolean;
  attempts: number;
  callId: string;
  json<T = unknown>(): T;
  raw: unknown;
  /** Provider finish reason, e.g. "stop", "length", "tool_calls"; null if unknown. */
  finishReason?: string | null;
  /** True when the model stopped because it hit max_tokens. */
  truncated?: boolean;
  /** Reasoning text if the provider returned it, else null. */
  reasoning?: string | null;
}

export interface ChatOptions {
  tools?: Tool[] | undefined;
  json?: boolean | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  project?: string | undefined;
  tag?: string | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  stop?: string | string[] | null | undefined;
  n?: number | null | undefined;
}

export interface EmbedOptions {
  model?: string | undefined;
  dimensions?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface EmbedResult extends Array<Float32Array> {
  dim: number;
  dimensions: number;
  tokensIn: number | null;
  costUsd: number | null;
  vectors: Float32Array[];
}

export function createReply(
  data: Omit<Reply, "json"> & {
    json?: (<T = unknown>() => T) | undefined;
    finishReason?: string | null | undefined;
    truncated?: boolean | undefined;
    reasoning?: string | null | undefined;
  },
): Reply {
  const customJson = data.json;
  return {
    ...data,
    finishReason: data.finishReason ?? null,
    truncated: data.truncated ?? false,
    reasoning: data.reasoning ?? null,
    json<T = unknown>(): T {
      if (customJson) {
        return customJson.call(this) as T;
      }
      try {
        return JSON.parse(this.text) as T;
      } catch (err) {
        const bad = new BadJSONError(
          `Failed to parse reply text as JSON: ${(err as Error).message}`,
          { model: this.model, cause: err },
        );
        bad.rawText = this.text;
        throw bad;
      }
    },
  };
}
