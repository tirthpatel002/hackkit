import { z } from "zod";
import { registerCheck } from "@hackkit/harness";
import type { CheckContext, CheckResult } from "../../../src/types.js";

export const maxLengthPlugin = {
  type: "maxLength",
  options: z.object({ chars: z.number().int().positive() }),
  run: (o: { chars: number }, ctx: CheckContext): CheckResult => {
    const n = ctx.output.text.length;
    return {
      type: "maxLength",
      passed: n <= o.chars,
      score: null,
      reason: `${n} chars`,
    };
  },
};

registerCheck(maxLengthPlugin);
