export const isUpperCase = async (
  _caseObj: unknown,
  out: { text: string },
): Promise<{ type: string; passed: boolean; score: null; reason: string }> => {
  const passed = out.text === out.text.toUpperCase();
  return {
    type: "custom",
    passed,
    score: null,
    reason: passed ? "" : "Text is not uppercase",
  };
};
