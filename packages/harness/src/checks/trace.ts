import { z } from "zod";
import { ConfigError } from "../errors.js";
import type {
  AgentTrace,
  CaseOutput,
  CheckContext,
  CheckPlugin,
  CheckResult,
  TraceStep,
} from "../types.js";

const REGISTRY_KEY = Symbol.for("@hackkit/harness.registry");

function getCheck(type: string): CheckPlugin<any> | undefined {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, CheckPlugin<any>> };
  return g[REGISTRY_KEY]?.get(type);
}

export function resolveField(output: CaseOutput, fieldPath: string = "text"): unknown {
  if (fieldPath === "text") return output.text;
  const parts = fieldPath.split(".");
  let cur: unknown = output;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function isSubset(subset: unknown, target: unknown): boolean {
  if (subset === target) return true;
  if (subset === null || target === null) return subset === target;
  if (typeof subset !== "object" || typeof target !== "object") {
    return subset === target;
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(target)) return false;
    return subset.every((subItem) =>
      target.some((targetItem) => isSubset(subItem, targetItem)),
    );
  }
  if (Array.isArray(target)) return false;
  const targetObj = target as Record<string, unknown>;
  for (const [key, val] of Object.entries(subset as Record<string, unknown>)) {
    if (!(key in targetObj)) return false;
    if (!isSubset(val, targetObj[key])) return false;
  }
  return true;
}

// 1. toolCalled
export const ToolCalledOptionsSchema = z
  .object({
    type: z.literal("toolCalled").optional(),
    tool: z.string().min(1, "tool name is required"),
    min: z.number().int().min(0).optional().default(1),
    max: z.number().int().min(0).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ToolCalledOptions = z.infer<typeof ToolCalledOptionsSchema>;

export const toolCalledPlugin: CheckPlugin<ToolCalledOptions> = {
  type: "toolCalled",
  options: ToolCalledOptionsSchema,
  needsTrace: true,
  run(opts, ctx: CheckContext): CheckResult {
    if (!ctx.trace) {
      return {
        type: "toolCalled",
        passed: false,
        score: 0,
        reason: "Check requires agent trace",
      };
    }
    const steps: TraceStep[] = ctx.trace.steps ?? [];
    const matchingSteps = steps.filter((step) => {
      if (step.type !== "tool_call" || step.tool !== opts.tool) {
        return false;
      }
      if (opts.args !== undefined) {
        return isSubset(opts.args, step.input);
      }
      return true;
    });

    const count = matchingSteps.length;
    const min = opts.min ?? 1;
    let passed = count >= min;
    if (opts.max !== undefined) {
      passed = passed && count <= opts.max;
    }

    let reason = "";
    if (!passed) {
      if (opts.max !== undefined) {
        reason = `Tool "${opts.tool}" called ${count} times, expected between ${min} and ${opts.max}`;
      } else {
        reason = `Tool "${opts.tool}" called ${count} times, expected at least ${min}`;
      }
    }

    return {
      type: "toolCalled",
      passed,
      score: passed ? 1 : 0,
      reason,
    };
  },
};

// 2. toolNotCalled
export const ToolNotCalledOptionsSchema = z
  .object({
    type: z.literal("toolNotCalled").optional(),
    tool: z.string().min(1, "tool name is required"),
  })
  .passthrough();

export type ToolNotCalledOptions = z.infer<typeof ToolNotCalledOptionsSchema>;

export const toolNotCalledPlugin: CheckPlugin<ToolNotCalledOptions> = {
  type: "toolNotCalled",
  options: ToolNotCalledOptionsSchema,
  needsTrace: true,
  run(opts, ctx: CheckContext): CheckResult {
    if (!ctx.trace) {
      return {
        type: "toolNotCalled",
        passed: false,
        score: 0,
        reason: "Check requires agent trace",
      };
    }
    const steps: TraceStep[] = ctx.trace.steps ?? [];
    const called = steps.some(
      (step) => step.type === "tool_call" && step.tool === opts.tool,
    );
    const passed = !called;

    return {
      type: "toolNotCalled",
      passed,
      score: passed ? 1 : 0,
      reason: passed ? "" : `Tool "${opts.tool}" was called in trace`,
    };
  },
};

// 3. order
export const OrderOptionsSchema = z
  .object({
    type: z.literal("order").optional(),
    tools: z.array(z.string()).min(1, "tools must contain at least one tool"),
    strict: z.boolean().optional().default(false),
  })
  .passthrough();

export type OrderOptions = z.infer<typeof OrderOptionsSchema>;

export const orderPlugin: CheckPlugin<OrderOptions> = {
  type: "order",
  options: OrderOptionsSchema,
  needsTrace: true,
  run(opts, ctx: CheckContext): CheckResult {
    if (!ctx.trace) {
      return {
        type: "order",
        passed: false,
        score: 0,
        reason: "Check requires agent trace",
      };
    }
    const steps: TraceStep[] = ctx.trace.steps ?? [];
    const calledTools = steps
      .filter((s) => s.type === "tool_call" && typeof s.tool === "string")
      .map((s) => s.tool as string);

    let passed = false;
    if (opts.tools.length === 0) {
      passed = true;
    } else if (opts.strict) {
      // Strict means adjacent in calledTools
      for (let i = 0; i <= calledTools.length - opts.tools.length; i++) {
        if (opts.tools.every((t, j) => calledTools[i + j] === t)) {
          passed = true;
          break;
        }
      }
    } else {
      // Subsequence, gaps allowed
      let searchIdx = 0;
      for (const tool of calledTools) {
        if (tool === opts.tools[searchIdx]) {
          searchIdx++;
          if (searchIdx === opts.tools.length) break;
        }
      }
      passed = searchIdx === opts.tools.length;
    }

    let reason = "";
    if (!passed) {
      if (opts.strict) {
        reason = `Tools [${opts.tools.join(", ")}] did not appear adjacently in order. Called: [${calledTools.join(", ")}]`;
      } else {
        reason = `Tools [${opts.tools.join(", ")}] did not appear in order. Called: [${calledTools.join(", ")}]`;
      }
    }

    return {
      type: "order",
      passed,
      score: passed ? 1 : 0,
      reason,
    };
  },
};

// 4. maxSteps
export const MaxStepsOptionsSchema = z
  .object({
    type: z.literal("maxSteps").optional(),
    value: z.number().int().min(0, "value must be non-negative"),
  })
  .passthrough();

export type MaxStepsOptions = z.infer<typeof MaxStepsOptionsSchema>;

export const maxStepsPlugin: CheckPlugin<MaxStepsOptions> = {
  type: "maxSteps",
  options: MaxStepsOptionsSchema,
  needsTrace: true,
  run(opts, ctx: CheckContext): CheckResult {
    if (!ctx.trace) {
      return {
        type: "maxSteps",
        passed: false,
        score: 0,
        reason: "Check requires agent trace",
      };
    }
    const count = ctx.trace.steps?.length ?? 0;
    const passed = count <= opts.value;

    return {
      type: "maxSteps",
      passed,
      score: passed ? 1 : 0,
      reason: passed ? "" : `Expected at most ${opts.value} steps, got ${count}`,
    };
  },
};

// 5. finalOutput
export const FinalOutputOptionsSchema = z
  .object({
    type: z.literal("finalOutput").optional(),
    check: z
      .object({
        type: z.string().min(1, "Nested check type is required"),
        field: z.string().optional(),
        negate: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type FinalOutputOptions = z.infer<typeof FinalOutputOptionsSchema>;

export const finalOutputPlugin: CheckPlugin<FinalOutputOptions> = {
  type: "finalOutput",
  options: FinalOutputOptionsSchema,
  needsTrace: true,
  async run(opts, ctx: CheckContext): Promise<CheckResult> {
    if (!ctx.trace) {
      return {
        type: "finalOutput",
        passed: false,
        score: 0,
        reason: "Check requires agent trace",
      };
    }
    const nestedSpec = opts.check;
    const plugin = getCheck(nestedSpec.type);
    if (!plugin) {
      throw new ConfigError(`Unknown check type "${nestedSpec.type}" in finalOutput`);
    }
    if (plugin.needsTrace) {
      throw new ConfigError(
        `Trace-only check "${nestedSpec.type}" cannot be used inside finalOutput`,
      );
    }

    const finalOutput = ctx.trace.final;
    const fieldValue = resolveField(finalOutput, nestedSpec.field ?? "text");
    const targetText =
      typeof fieldValue === "string" ? fieldValue : String(fieldValue ?? "");
    const checkOutput: CaseOutput = { ...finalOutput, text: targetText };

    let result = await plugin.run(nestedSpec, {
      ...ctx,
      output: checkOutput,
    });

    if (nestedSpec.negate) {
      const passed = !result.passed;
      result = {
        ...result,
        passed,
        reason: passed
          ? result.reason
            ? `(negated) ${result.reason}`
            : ""
          : result.reason || `Negated check ${nestedSpec.type} failed`,
      };
    }

    return {
      type: "finalOutput",
      passed: result.passed,
      score: result.score,
      reason: result.reason,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    };
  },
};
