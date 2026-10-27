import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { CheckPlugin, CheckResult, CheckContext, Case, CaseOutput } from "../types.js";

export const ExactOptionsSchema = z.object({
  value: z.unknown().optional(),
  case_sensitive: z.boolean().optional(),
}).passthrough();

export type ExactOptions = z.infer<typeof ExactOptionsSchema>;

export const exactPlugin: CheckPlugin<ExactOptions> = {
  type: "exact",
  options: ExactOptionsSchema,
  run(opts, ctx): CheckResult {
    const target = ctx.output.text;
    const expectedVal = opts.value !== undefined ? opts.value : ctx.case.expect;

    if (expectedVal === undefined) {
      return {
        type: "exact",
        passed: false,
        score: 0,
        reason: "No expected value provided for exact check",
      };
    }

    const expectedStr = String(expectedVal);
    const trimmedTarget = target.trim();
    const trimmedExpected = expectedStr.trim();

    const passed = opts.case_sensitive
      ? trimmedTarget === trimmedExpected
      : trimmedTarget.toLowerCase() === trimmedExpected.toLowerCase();

    return {
      type: "exact",
      passed,
      score: passed ? 1 : 0,
      reason: passed ? "" : `Expected exact match "${trimmedExpected}", got "${trimmedTarget}"`,
    };
  },
};

export const ContainsOptionsSchema = z.object({
  value: z.union([z.string(), z.array(z.string())]),
  all_of: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
}).passthrough();

export type ContainsOptions = z.infer<typeof ContainsOptionsSchema>;

export const containsPlugin: CheckPlugin<ContainsOptions> = {
  type: "contains",
  options: ContainsOptionsSchema,
  run(opts, ctx): CheckResult {
    const target = ctx.output.text;
    const values = Array.isArray(opts.value) ? opts.value : [opts.value];
    const allOf = opts.all_of ?? true;
    const caseSensitive = opts.case_sensitive ?? false;

    const haystack = caseSensitive ? target : target.toLowerCase();
    const missing: string[] = [];
    const found: string[] = [];

    for (const val of values) {
      const needle = caseSensitive ? val : val.toLowerCase();
      if (haystack.includes(needle)) {
        found.push(val);
      } else {
        missing.push(val);
      }
    }

    const passed = allOf ? missing.length === 0 : found.length > 0;
    let reason = "";
    if (!passed) {
      if (allOf) {
        reason = `Missing required substring(s): ${missing.map((s) => JSON.stringify(s)).join(", ")}`;
      } else {
        reason = `Did not contain any of: ${values.map((s) => JSON.stringify(s)).join(", ")}`;
      }
    }

    return {
      type: "contains",
      passed,
      score: passed ? 1 : 0,
      reason,
    };
  },
};

const moduleCache = new Map<string, Record<string, unknown>>();

export function clearModuleCache(): void {
  moduleCache.clear();
}

export type CustomCheckFn = (c: Case, out: CaseOutput) => Promise<CheckResult | boolean> | CheckResult | boolean;

export async function loadExport(fnSpec: string, projectDir?: string): Promise<CustomCheckFn> {
  const colonIndex = fnSpec.lastIndexOf(":");
  if (colonIndex === -1 || colonIndex === 0 || colonIndex === fnSpec.length - 1) {
    throw new ConfigError(`Invalid custom check fn spec: "${fnSpec}". Expected format "file.ts:exportName"`);
  }

  const filePath = fnSpec.slice(0, colonIndex);
  const exportName = fnSpec.slice(colonIndex + 1);

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir || process.cwd(), filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`Custom check module not found: ${resolvedPath}`);
  }

  const fileUrl = pathToFileURL(resolvedPath).href;
  let mod = moduleCache.get(fileUrl);
  if (!mod) {
    try {
      mod = (await import(fileUrl)) as Record<string, unknown>;
      moduleCache.set(fileUrl, mod);
    } catch (err) {
      throw new ConfigError(
        `Failed to load custom check module ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const fn = mod[exportName];
  if (typeof fn !== "function") {
    throw new ConfigError(`Export "${exportName}" not found or not a function in ${resolvedPath}`);
  }

  return fn as CustomCheckFn;
}

export const CustomOptionsSchema = z.object({
  fn: z.string(),
}).passthrough();

export type CustomOptions = z.infer<typeof CustomOptionsSchema>;

export const customPlugin: CheckPlugin<CustomOptions> = {
  type: "custom",
  options: CustomOptionsSchema,
  async run(opts, ctx: CheckContext): Promise<CheckResult> {
    const fn = await loadExport(opts.fn, ctx.projectDir);
    const res = await fn(ctx.case, ctx.output);

    if (typeof res === "boolean") {
      return {
        type: "custom",
        passed: res,
        score: res ? 1 : 0,
        reason: res ? "" : "Custom check returned false",
      };
    }

    return {
      type: "custom",
      passed: Boolean(res.passed),
      score: res.score ?? null,
      reason: res.reason ?? "",
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    };
  },
};
