import type { Case, CaseOutput, CheckResult } from "../../src/types.js";

export const samplePassCheck = async (_c: Case, out: CaseOutput): Promise<CheckResult> => ({
  type: "custom",
  passed: out.text.includes("pass"),
  score: 1,
  reason: "Contains pass",
});

export const sampleBooleanCheck = async (_c: Case, out: CaseOutput): Promise<boolean> =>
  out.text === "valid";

export const notAFunction = "I am a string";
