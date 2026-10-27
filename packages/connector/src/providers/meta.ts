import type OpenAI from "openai";
import { OpenAICompatProvider, type OpenAICompatConfig } from "./openaiCompat.js";
import type { Message, ChatOptions } from "../types.js";

export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const META_DEFAULT_KEY_ENV = "META_API_KEY";

export class MetaProvider extends OpenAICompatProvider {
  constructor(cfg?: Partial<OpenAICompatConfig>) {
    super("meta", {
      baseUrl: cfg?.baseUrl ?? META_DEFAULT_BASE_URL,
      keyEnv: cfg?.keyEnv ?? META_DEFAULT_KEY_ENV,
      timeoutMs: cfg?.timeoutMs ?? 120000,
      ...(cfg?.fetch !== undefined ? { fetch: cfg.fetch } : {}),
    });
  }

  protected override prepareBody(
    modelId: string,
    messages: Message[],
    opts?: ChatOptions,
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const body = super.prepareBody(modelId, messages, opts);

    // Meta quirk: strip stop and n from requests
    delete (body as { stop?: unknown }).stop;
    delete (body as { n?: unknown }).n;

    // Meta docs: Muse Spark always reasons; reasoning_effort: "none" returns 400;
    // logit_bias also returns 400. Strip them if present.
    delete (body as { logit_bias?: unknown }).logit_bias;
    delete (body as { reasoning_effort?: unknown }).reasoning_effort;

    return body;
  }
}
