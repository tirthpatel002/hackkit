import type { Message, ToolCall, ChatOptions } from "../types.js";

export interface ProviderChatResult {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  raw: unknown;
  httpStatus?: number | undefined;
}

export interface Provider {
  readonly name: string;
  chat(modelId: string, messages: Message[], opts?: ChatOptions): Promise<ProviderChatResult>;
}
