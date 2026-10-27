import { OpenAICompatProvider, type OpenAICompatConfig } from "./openaiCompat.js";

export const NEBIUS_DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
export const NEBIUS_DEFAULT_KEY_ENV = "NEBIUS_API_KEY";

export class NebiusProvider extends OpenAICompatProvider {
  constructor(cfg?: Partial<OpenAICompatConfig>) {
    super("nebius", {
      baseUrl: cfg?.baseUrl ?? NEBIUS_DEFAULT_BASE_URL,
      keyEnv: cfg?.keyEnv ?? NEBIUS_DEFAULT_KEY_ENV,
      timeoutMs: cfg?.timeoutMs ?? 60000,
      ...(cfg?.fetch !== undefined ? { fetch: cfg.fetch } : {}),
    });
  }
}
