import type { AgentTrace, RunAgent, TraceStep } from "../../src/types.js";

export const runAgent: RunAgent = async (input, ctx): Promise<AgentTrace> => {
  if (process.env.ECHO_DELAY_MS) {
    const delay = parseInt(process.env.ECHO_DELAY_MS, 10);
    if (!isNaN(delay) && delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (ctx.signal) {
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      });
    }
  }

  if (ctx.signal?.aborted) {
    throw new Error("aborted");
  }

  const steps: TraceStep[] = [];
  let seq = 1;

  steps.push({
    seq: seq++,
    type: "step",
    input: input.task,
  });

  // Toy loop over fake "search" and "calculator" tools
  steps.push({
    seq: seq++,
    type: "tool_call",
    tool: "search",
    input: { query: "population of Pune" },
  });

  steps.push({
    seq: seq++,
    type: "tool_result",
    tool: "search",
    output: { result: "3124458" },
  });

  steps.push({
    seq: seq++,
    type: "tool_call",
    tool: "calculator",
    input: { expression: "3124458 / 1000" },
  });

  steps.push({
    seq: seq++,
    type: "tool_result",
    tool: "calculator",
    output: { result: "3124.458" },
  });

  const finalOutputText =
    "The population of Pune divided by 1000 is approximately 3124 (about 3.124 thousand).";

  steps.push({
    seq: seq++,
    type: "step",
    output: finalOutputText,
  });

  return {
    steps,
    final: {
      text: finalOutputText,
    },
  };
};
