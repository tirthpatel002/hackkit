import OpenAI from "openai";
import type { Message, ToolCall, ChatOptions } from "../types.js";
import type { Provider, ProviderChatResult } from "./base.js";
import {
  ConnectorError,
  ConfigError,
  AuthError,
  BadRequestError,
  RateLimitError,
  ProviderTimeout,
  ProviderError,
  BadJSONError,
} from "../errors.js";

export interface OpenAICompatConfig {
  baseUrl: string;
  keyEnv: string;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

export function mapOpenAIError(err: unknown, model: string): ConnectorError {
  if (err instanceof ConnectorError) {
    return err;
  }

  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderTimeout(err.message, { model, status: 408, cause: err });
  }

  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderTimeout(err.message, { model, cause: err });
  }

  if (
    err instanceof OpenAI.RateLimitError ||
    (err instanceof OpenAI.APIError && err.status === 429)
  ) {
    const rateLimit = new RateLimitError(err.message, { model, status: 429, cause: err });
    const headers = (err as { headers?: Headers | Record<string, string> }).headers;
    if (headers) {
      const getHeader = (h: string): string | null => {
        if (typeof (headers as Headers).get === "function") {
          return (headers as Headers).get(h);
        }
        return (headers as Record<string, string>)[h] ?? (headers as Record<string, string>)[h.toLowerCase()] ?? null;
      };

      const retryMs = getHeader("retry-after-ms");
      const retryAfter = getHeader("retry-after");
      if (retryMs) {
        const ms = Number(retryMs);
        if (!isNaN(ms)) rateLimit.retryAfterMs = ms;
      } else if (retryAfter) {
        const sec = Number(retryAfter);
        if (!isNaN(sec)) {
          rateLimit.retryAfterMs = sec * 1000;
        } else {
          const date = Date.parse(retryAfter);
          if (!isNaN(date)) {
            rateLimit.retryAfterMs = Math.max(0, date - Date.now());
          }
        }
      }
    }
    return rateLimit;
  }

  if (
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError ||
    (err instanceof OpenAI.APIError && (err.status === 401 || err.status === 403))
  ) {
    const status = (err as { status?: number }).status ?? 401;
    return new AuthError((err as Error).message, { model, status, cause: err });
  }

  if (
    err instanceof OpenAI.BadRequestError ||
    err instanceof OpenAI.NotFoundError ||
    err instanceof OpenAI.UnprocessableEntityError ||
    (err instanceof OpenAI.APIError && [400, 404, 413, 422].includes((err as { status?: number }).status ?? 0))
  ) {
    const status = (err as { status?: number }).status ?? 400;
    return new BadRequestError((err as Error).message, { model, status, cause: err });
  }

  if (
    err instanceof OpenAI.InternalServerError ||
    (err instanceof OpenAI.APIError && ((err as { status?: number }).status ?? 0) >= 500)
  ) {
    const status = (err as { status?: number }).status ?? 500;
    return new ProviderError((err as Error).message, { model, status, cause: err });
  }

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("timeout")) {
      return new ProviderTimeout(err.message, { model, cause: err });
    }
    return new ProviderError(err.message, { model, cause: err });
  }

  return new ProviderError(String(err), { model });
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  protected cfg: OpenAICompatConfig;

  constructor(name: string, cfg: OpenAICompatConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  createClient(opts?: ChatOptions): OpenAI {
    const apiKey = process.env[this.cfg.keyEnv];
    if (!apiKey) {
      throw new ConfigError(`Missing environment variable ${this.cfg.keyEnv}`, { model: this.name });
    }

    const effectiveFetch = opts?.fetch ?? this.cfg.fetch;
    const timeout = opts?.timeoutMs ?? this.cfg.timeoutMs;

    return new OpenAI({
      baseURL: this.cfg.baseUrl,
      apiKey,
      maxRetries: 0,
      ...(timeout !== undefined ? { timeout } : {}),
      ...(effectiveFetch !== undefined ? { fetch: effectiveFetch } : {}),
    });
  }

  async chat(
    modelId: string,
    messages: Message[],
    opts?: ChatOptions,
  ): Promise<ProviderChatResult> {
    const client = this.createClient(opts);

    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: modelId,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    };

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }
    if (opts?.maxTokens !== undefined) {
      body.max_completion_tokens = opts.maxTokens;
    }
    if (opts?.json) {
      body.response_format = { type: "json_object" };
    }
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = opts.tools as OpenAI.Chat.ChatCompletionTool[];
    }

    try {
      const completion = await client.chat.completions.create(body, {
        signal: opts?.signal,
      });

      const choice = completion.choices[0];
      const message = choice?.message;
      const text = message?.content ?? "";

      const toolCalls: ToolCall[] = [];
      if (message?.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          if (tc.type === "function" && tc.function) {
            const rawArgs = tc.function.arguments ?? "";
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch (parseErr) {
              const bad = new BadJSONError(
                `Failed to parse arguments for tool "${tc.function.name}": ${(parseErr as Error).message}`,
                { model: `${this.name}:${modelId}`, cause: parseErr },
              );
              bad.rawText = rawArgs;
              throw bad;
            }
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: parsedArgs,
            });
          }
        }
      }

      const usage = completion.usage;
      const tokensIn = usage?.prompt_tokens ?? null;
      const tokensOut = usage?.completion_tokens ?? null;
      const cached = (usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
        ?.prompt_tokens_details?.cached_tokens;
      const tokensCached = cached ?? (tokensIn !== null ? 0 : null);

      return {
        text,
        toolCalls,
        tokensIn,
        tokensOut,
        tokensCached,
        raw: completion,
        httpStatus: 200,
      };
    } catch (err) {
      throw mapOpenAIError(err, `${this.name}:${modelId}`);
    }
  }
}
