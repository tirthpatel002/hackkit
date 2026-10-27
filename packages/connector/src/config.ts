import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import yaml from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";

// Load .env at import of config.ts
dotenv.config();

export const DEFAULT_ALIASES: Record<string, string> = {
  main: "nebius:nvidia/nemotron-3-super-120b-a12b",
  cheap: "nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  judge: "nebius:nvidia/nemotron-3-super-120b-a12b",
  local: "agy-cli:gemini-3.8-flash-high",
  embed: "nebius:Qwen/Qwen3-Embedding-8B",
};

export const DEFAULT_FALLBACK: Record<string, string[]> = {
  main: ["nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "meta:muse-spark-1.3"],
  cheap: ["nebius:nvidia/nemotron-3-super-120b-a12b"],
  judge: ["meta:muse-spark-1.3"],
  local: ["nebius:nvidia/nemotron-3-super-120b-a12b"],
  embed: [],
};

const defaultsSchema = z
  .object({
    timeout_ms: z.number().optional(),
    timeoutMs: z.number().optional(),
    max_retries: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .transform((val) => ({
    timeoutMs: val.timeoutMs ?? val.timeout_ms ?? 60000,
    maxRetries: val.maxRetries ?? val.max_retries ?? 3,
  }));

const nebiusSchema = z
  .object({
    base_url: z.string().optional(),
    baseUrl: z.string().optional(),
    key_env: z.string().optional(),
    keyEnv: z.string().optional(),
    timeout_ms: z.number().optional(),
    timeoutMs: z.number().optional(),
  })
  .transform((val) => ({
    baseUrl: val.baseUrl ?? val.base_url ?? "https://api.tokenfactory.nebius.com/v1/",
    keyEnv: val.keyEnv ?? val.key_env ?? "NEBIUS_API_KEY",
    ...(val.timeoutMs !== undefined
      ? { timeoutMs: val.timeoutMs }
      : val.timeout_ms !== undefined
        ? { timeoutMs: val.timeout_ms }
        : {}),
  }));

const metaSchema = z
  .object({
    base_url: z.string().optional(),
    baseUrl: z.string().optional(),
    key_env: z.string().optional(),
    keyEnv: z.string().optional(),
    timeout_ms: z.number().optional(),
    timeoutMs: z.number().optional(),
  })
  .transform((val) => ({
    baseUrl: val.baseUrl ?? val.base_url ?? "https://api.meta.ai/v1",
    keyEnv: val.keyEnv ?? val.key_env ?? "META_API_KEY",
    timeoutMs: val.timeoutMs ?? val.timeout_ms ?? 120000,
  }));

const agyCliSchema = z
  .object({
    bin: z.string().optional(),
    wrapper: z.array(z.string()).optional(),
    default_model: z.string().optional(),
    defaultModel: z.string().optional(),
    timeout_ms: z.number().optional(),
    timeoutMs: z.number().optional(),
    max_retries: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .transform((val) => ({
    bin: val.bin ?? "~/.local/bin/agy",
    wrapper: val.wrapper ?? [],
    defaultModel: val.defaultModel ?? val.default_model ?? "gemini-3.8-flash-high",
    timeoutMs: val.timeoutMs ?? val.timeout_ms ?? 300000,
    maxRetries: val.maxRetries ?? val.max_retries ?? 0,
  }));

const providersSchema = z
  .object({
    nebius: nebiusSchema.optional(),
    meta: metaSchema.optional(),
    "agy-cli": agyCliSchema.optional(),
    agyCli: agyCliSchema.optional(),
  })
  .transform((val) => {
    const agy = val["agy-cli"] ?? val.agyCli;
    return {
      nebius: val.nebius ?? nebiusSchema.parse({}),
      meta: val.meta ?? metaSchema.parse({}),
      "agy-cli": agy ?? agyCliSchema.parse({}),
    };
  });

const rawConfigSchema = z
  .object({
    project: z.string().optional(),
    defaults: defaultsSchema.optional(),
    providers: providersSchema.optional(),
    aliases: z.record(z.string(), z.string()).optional(),
    fallback: z.record(z.string(), z.array(z.string())).optional(),
  })
  .transform((val) => ({
    ...(val.project !== undefined ? { project: val.project } : {}),
    defaults: val.defaults ?? defaultsSchema.parse({}),
    providers: val.providers ?? providersSchema.parse({}),
    aliases: { ...DEFAULT_ALIASES, ...(val.aliases ?? {}) },
    fallback: { ...DEFAULT_FALLBACK, ...(val.fallback ?? {}) },
  }));

export interface ConnectorConfig {
  project?: string | undefined;
  defaults: {
    timeoutMs: number;
    maxRetries: number;
  };
  providers: {
    nebius: {
      baseUrl: string;
      keyEnv: string;
      timeoutMs?: number | undefined;
    };
    meta: {
      baseUrl: string;
      keyEnv: string;
      timeoutMs: number;
    };
    "agy-cli": {
      bin: string;
      wrapper: string[];
      defaultModel: string;
      timeoutMs: number;
      maxRetries: number;
    };
  };
  aliases: Record<string, string>;
  fallback: Record<string, string[]>;
}

export type ConnectorConfigInput = z.input<typeof rawConfigSchema>;

export function defineConfig(config: ConnectorConfigInput): ConnectorConfigInput {
  return config;
}

export function parseConfig(raw: unknown): ConnectorConfig {
  const result = rawConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid connector config: ${result.error.message}`);
  }
  return result.data;
}

export function loadConfigSync(filePath?: string): ConnectorConfig {
  const resolvedPath =
    filePath ??
    process.env.CONNECTOR_CONFIG ??
    (fs.existsSync(path.resolve(process.cwd(), "config/models.yaml"))
      ? path.resolve(process.cwd(), "config/models.yaml")
      : undefined);

  if (!resolvedPath) {
    return parseConfig({});
  }

  const absPath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.resolve(process.cwd(), resolvedPath);

  if (!fs.existsSync(absPath)) {
    throw new ConfigError(`Config file not found at ${absPath}`);
  }

  if (absPath.endsWith(".yaml") || absPath.endsWith(".yml")) {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const parsed = yaml.parse(content) as unknown;
      return parseConfig(parsed);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Failed to parse YAML config at ${absPath}: ${(err as Error).message}`);
    }
  }

  throw new ConfigError(`Synchronous loading only supports YAML files. Use loadConfig() for ${absPath}`);
}

export async function loadConfig(filePath?: string): Promise<ConnectorConfig> {
  const target = filePath ?? process.env.CONNECTOR_CONFIG;

  if (target) {
    const absPath = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (!fs.existsSync(absPath)) {
      throw new ConfigError(`Config file not found at ${absPath}`);
    }
    if (absPath.endsWith(".yaml") || absPath.endsWith(".yml")) {
      return loadConfigSync(absPath);
    }
    try {
      const mod = (await import(pathToFileURL(absPath).href)) as { default?: unknown };
      const raw = mod.default ?? mod;
      return parseConfig(raw);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Failed to load config file at ${absPath}: ${(err as Error).message}`);
    }
  }

  const tsPath = path.resolve(process.cwd(), "config/models.config.ts");
  if (fs.existsSync(tsPath)) {
    try {
      const mod = (await import(pathToFileURL(tsPath).href)) as { default?: unknown };
      const raw = mod.default ?? mod;
      return parseConfig(raw);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Failed to load config from ${tsPath}: ${(err as Error).message}`);
    }
  }

  const yamlPath = path.resolve(process.cwd(), "config/models.yaml");
  if (fs.existsSync(yamlPath)) {
    return loadConfigSync(yamlPath);
  }

  return parseConfig({});
}

let activeConfig: ConnectorConfig | null = null;

export async function getConfig(): Promise<ConnectorConfig> {
  if (!activeConfig) {
    activeConfig = await loadConfig();
  }
  return activeConfig;
}

export function setConfig(config: ConnectorConfig | null): void {
  activeConfig = config;
}

export interface ResolvedModel {
  provider: string;
  modelId: string;
  fullName: string;
}

export function resolveModel(model: string, config: ConnectorConfig): ResolvedModel {
  if (model === "agy-cli") {
    const defaultModel = config.providers["agy-cli"].defaultModel;
    return {
      provider: "agy-cli",
      modelId: defaultModel,
      fullName: `agy-cli:${defaultModel}`,
    };
  }

  if (model.includes(":")) {
    const idx = model.indexOf(":");
    const provider = model.slice(0, idx);
    const modelId = model.slice(idx + 1);
    return { provider, modelId, fullName: model };
  }

  const target = config.aliases[model];
  if (!target) {
    throw new ConfigError(`Unknown model alias "${model}"`, { model });
  }

  if (target === "agy-cli") {
    const defaultModel = config.providers["agy-cli"].defaultModel;
    return {
      provider: "agy-cli",
      modelId: defaultModel,
      fullName: `agy-cli:${defaultModel}`,
    };
  }

  const idx = target.indexOf(":");
  if (idx === -1) {
    throw new ConfigError(`Invalid target "${target}" for alias "${model}"`, { model });
  }

  return {
    provider: target.slice(0, idx),
    modelId: target.slice(idx + 1),
    fullName: target,
  };
}

export function getProviderApiKey(provider: string, config: ConnectorConfig): string {
  if (provider === "nebius") {
    const keyEnv = config.providers.nebius.keyEnv;
    const key = process.env[keyEnv];
    if (!key) {
      throw new ConfigError(`Missing environment variable ${keyEnv}`, { model: provider });
    }
    return key;
  }

  if (provider === "meta") {
    const keyEnv = config.providers.meta.keyEnv;
    const key = process.env[keyEnv];
    if (!key) {
      throw new ConfigError(`Missing environment variable ${keyEnv}`, { model: provider });
    }
    return key;
  }

  return "";
}
