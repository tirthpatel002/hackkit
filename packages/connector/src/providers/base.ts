import type { Message, ToolCall, ChatOptions } from "../types.js";

export interface ProviderChatResult {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  raw: unknown;
  httpStatus?: number | undefined;
  exitCode?: number | null | undefined;
  json?: (<T = unknown>() => T) | undefined;
  /** Provider finish reason, e.g. "stop", "length", "tool_calls". */
  finishReason?: string | null | undefined;
  /** True when the reply was cut off by max_tokens. */
  truncated?: boolean | undefined;
  /** Reasoning text (reasoning_content / reasoning), if the provider returned it. */
  reasoning?: string | null | undefined;
}

export interface Provider {
  readonly name: string;
  chat(modelId: string, messages: Message[], opts?: ChatOptions): Promise<ProviderChatResult>;
}
