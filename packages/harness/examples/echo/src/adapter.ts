import type { CaseOutput, RunCase } from "../../src/types.js";

export const runCase: RunCase = async (input, ctx): Promise<CaseOutput> => {
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

  if (process.env.ECHO_PLANT_FAIL === "1") {
    if (input.text === "hello") {
      return { text: "wrong" };
    }
  }

  if (typeof input.text === "string") {
    return { text: input.text.toUpperCase() };
  }

  if (input.question === "What is the capital of France?") {
    return { text: "Paris." };
  }

  return { text: "default echo answer" };
};
