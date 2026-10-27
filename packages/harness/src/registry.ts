import { ConfigError } from "./errors.js";
import type { CheckPlugin } from "./types.js";
import { exactPlugin, containsPlugin, customPlugin } from "./checks/builtin.js";
import { judgePlugin } from "./checks/judge.js";
import {
  toolCalledPlugin,
  toolNotCalledPlugin,
  orderPlugin,
  maxStepsPlugin,
  finalOutputPlugin,
} from "./checks/trace.js";

const REGISTRY_KEY = Symbol.for("@hackkit/harness.registry");
type RegistryMap = Map<string, CheckPlugin<any>>;

function getRegistry(): RegistryMap {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: RegistryMap };
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map();
  }
  return g[REGISTRY_KEY];
}

export function registerCheck(plugin: CheckPlugin<any>): void {
  if (!plugin || typeof plugin.type !== "string" || !plugin.type) {
    throw new ConfigError("Invalid plugin: plugin type is required");
  }
  const registry = getRegistry();
  if (registry.has(plugin.type)) {
    throw new ConfigError(`Check type "${plugin.type}" is already registered`);
  }
  registry.set(plugin.type, plugin);
}

export function getCheck(type: string): CheckPlugin<any> | undefined {
  return getRegistry().get(type);
}

export function listChecks(): string[] {
  return Array.from(getRegistry().keys()).sort();
}

export function resetRegistry(): void {
  const registry = getRegistry();
  registry.clear();
  registerCheck(exactPlugin);
  registerCheck(containsPlugin);
  registerCheck(customPlugin);
  registerCheck(judgePlugin);
  registerCheck(toolCalledPlugin);
  registerCheck(toolNotCalledPlugin);
  registerCheck(orderPlugin);
  registerCheck(maxStepsPlugin);
  registerCheck(finalOutputPlugin);
}

// Register built-ins initially
resetRegistry();

