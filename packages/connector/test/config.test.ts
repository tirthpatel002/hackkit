import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadConfigSync,
  resolveModel,
  defineConfig,
  ConfigError,
  DEFAULT_ALIASES,
  getProviderApiKey,
} from "../src/index.js";

describe("config", () => {
  it("resolves model strings with colons directly without checking alias table", () => {
    const cfg = loadConfigSync();
    const res = resolveModel("nebius:custom/my-model", cfg);
    expect(res.provider).toBe("nebius");
    expect(res.modelId).toBe("custom/my-model");
    expect(res.fullName).toBe("nebius:custom/my-model");
  });

  it("resolves 'agy-cli' alone to agy-cli with default_model", () => {
    const cfg = loadConfigSync();
    const res = resolveModel("agy-cli", cfg);
    expect(res.provider).toBe("agy-cli");
    expect(res.modelId).toBe(cfg.providers["agy-cli"].defaultModel);
    expect(res.fullName).toBe(`agy-cli:${cfg.providers["agy-cli"].defaultModel}`);
  });

  it("resolves default aliases correctly", () => {
    const cfg = loadConfigSync();
    const main = resolveModel("main", cfg);
    expect(main.fullName).toBe(DEFAULT_ALIASES.main);

    const cheap = resolveModel("cheap", cfg);
    expect(cheap.fullName).toBe(DEFAULT_ALIASES.cheap);

    const local = resolveModel("local", cfg);
    expect(local.fullName).toBe(DEFAULT_ALIASES.local);
  });

  it("throws ConfigError for unknown alias", () => {
    const cfg = loadConfigSync();
    expect(() => resolveModel("nonexistent-alias", cfg)).toThrow(ConfigError);
    try {
      resolveModel("nonexistent-alias", cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("nonexistent-alias");
    }
  });

  it("throws ConfigError naming the environment variable when key is missing", () => {
    const cfg = loadConfigSync();
    const original = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;

    try {
      expect(() => getProviderApiKey("nebius", cfg)).toThrow(ConfigError);
      try {
        getProviderApiKey("nebius", cfg);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const msg = (err as ConfigError).message;
        // Must name the variable
        expect(msg).toContain("NEBIUS_API_KEY");
      }
    } finally {
      if (original !== undefined) {
        process.env.NEBIUS_API_KEY = original;
      }
    }
  });

  it("produces identical camelCase results from YAML and TS configs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-cfg-test-"));

    const yamlPath = path.join(tmpDir, "models.yaml");
    const tsPath = path.join(tmpDir, "models.config.ts");

    const yamlContent = `
project: test-project
defaults:
  timeout_ms: 45000
  max_retries: 2
providers:
  nebius:
    base_url: https://api.tokenfactory.nebius.com/v1/
    key_env: NEBIUS_API_KEY
    timeout_ms: 50000
  meta:
    base_url: https://api.meta.ai/v1
    key_env: META_API_KEY
    timeout_ms: 90000
  agy-cli:
    bin: ~/.local/bin/agy
    wrapper: [agy-as, acct2]
    default_model: gemini-3.8-flash-high
    timeout_ms: 200000
    max_retries: 0
aliases:
  main: nebius:nvidia/nemotron-3-super-120b-a12b
  fast: nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
fallback:
  main: [nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B]
`;

    const connectorIndex = fs.existsSync(path.resolve(process.cwd(), "src/index.ts"))
      ? path.resolve(process.cwd(), "src/index.ts")
      : path.resolve(process.cwd(), "packages/connector/src/index.ts");
    const connectorIndexPath = pathToFileURL(connectorIndex).href;
    const tsContent = `
import { defineConfig } from "${connectorIndexPath}";
export default defineConfig({
  project: "test-project",
  defaults: {
    timeoutMs: 45000,
    maxRetries: 2,
  },
  providers: {
    nebius: {
      baseUrl: "https://api.tokenfactory.nebius.com/v1/",
      keyEnv: "NEBIUS_API_KEY",
      timeoutMs: 50000,
    },
    meta: {
      baseUrl: "https://api.meta.ai/v1",
      keyEnv: "META_API_KEY",
      timeoutMs: 90000,
    },
    agyCli: {
      bin: "~/.local/bin/agy",
      wrapper: ["agy-as", "acct2"],
      defaultModel: "gemini-3.8-flash-high",
      timeoutMs: 200000,
      maxRetries: 0,
    },
  },
  aliases: {
    main: "nebius:nvidia/nemotron-3-super-120b-a12b",
    fast: "nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  },
  fallback: {
    main: ["nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"],
  },
});
`;

    fs.writeFileSync(yamlPath, yamlContent, "utf-8");
    fs.writeFileSync(tsPath, tsContent, "utf-8");

    try {
      const parsedYaml = await loadConfig(yamlPath);
      const parsedTs = await loadConfig(tsPath);

      expect(parsedYaml.project).toBe("test-project");
      expect(parsedTs.project).toBe("test-project");

      expect(parsedYaml.defaults).toEqual(parsedTs.defaults);
      expect(parsedYaml.defaults.timeoutMs).toBe(45000);
      expect(parsedYaml.defaults.maxRetries).toBe(2);

      expect(parsedYaml.providers.nebius).toEqual(parsedTs.providers.nebius);
      expect(parsedYaml.providers.meta).toEqual(parsedTs.providers.meta);
      expect(parsedYaml.providers["agy-cli"]).toEqual(parsedTs.providers["agy-cli"]);

      expect(parsedYaml.aliases).toEqual(parsedTs.aliases);
      expect(parsedYaml.fallback).toEqual(parsedTs.fallback);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws ConfigError when explicit CONNECTOR_CONFIG file is missing", async () => {
    await expect(loadConfig("/nonexistent/file/path/models.yaml")).rejects.toThrow(ConfigError);
  });
});
