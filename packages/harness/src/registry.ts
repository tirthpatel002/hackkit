import { ConfigError } from "./errors.js";
import type { CheckPlugin } from "./types.js";
import { exactPlugin, containsPlugin, customPlugin } from "./checks/builtin.js";

const registry = new Map<string, CheckPlugin<any>>();

export function registerCheck(plugin: CheckPlugin<any>): void {
  if (!plugin || typeof plugin.type !== "string" || !plugin.type) {
    throw new ConfigError("Invalid plugin: plugin type is required");
  }
  if (registry.has(plugin.type)) {
    throw new ConfigError(`Check type "${plugin.type}" is already registered`);
  }
  registry.set(plugin.type, plugin);
}

export function getCheck(type: string): CheckPlugin<any> | undefined {
  return registry.get(type);
}

export function listChecks(): string[] {
  return Array.from(registry.keys()).sort();
}

export function resetRegistry(): void {
  registry.clear();
  registerCheck(exactPlugin);
  registerCheck(containsPlugin);
  registerCheck(customPlugin);
}

// Register built-ins initially
resetRegistry();
