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

export function createReply(data: Omit<Reply, "json">): Reply {
  return {
    ...data,
    json<T = unknown>(): T {
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
