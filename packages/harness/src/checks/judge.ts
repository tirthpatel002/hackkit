import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Message, Reply } from "@hackkit/connector";
import { ConfigError } from "../errors.js";
import type { CheckContext, CheckPlugin, CheckResult } from "../types.js";

export const JudgeOptionsSchema = z
  .object({
    type: z.literal("judge").optional(),
    rubric: z.string().min(1, "rubric is required"),
    pass_score: z.number().int().min(1).max(5).optional().default(4),
    model: z.string().optional().default("judge"),
  })
  .passthrough();

export type JudgeOptions = z.infer<typeof JudgeOptionsSchema>;

export interface RubricDefinition {
  scale?: string;
  criteria?: string[];
  score_guide?: Record<string | number, string>;
}

export const JudgeReplySchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  reason: z.string(),
  failed_criteria: z.array(z.coerce.number()).optional().default([]),
});

export type JudgeReply = z.infer<typeof JudgeReplySchema>;

const rubricCache = new Map<string, Record<string, RubricDefinition>>();

export function clearRubricCache(): void {
  rubricCache.clear();
}

export function loadRubrics(rubricsFilePath: string): Record<string, RubricDefinition> {
  let cached = rubricCache.get(rubricsFilePath);
  if (cached) return cached;

  if (!fs.existsSync(rubricsFilePath)) {
    throw new ConfigError(`rubrics.yaml not found at ${rubricsFilePath}`);
  }

  const content = fs.readFileSync(rubricsFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (err) {
    throw new ConfigError(
      `Invalid YAML in rubrics file ${rubricsFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`rubrics file must contain a YAML mapping: ${rubricsFilePath}`);
  }

  cached = parsed as Record<string, RubricDefinition>;
  rubricCache.set(rubricsFilePath, cached);
  return cached;
}

export function formatRubricText(rubric: RubricDefinition): string {
  const parts: string[] = [];

  if (Array.isArray(rubric.criteria) && rubric.criteria.length > 0) {
    parts.push("Criteria:");
    rubric.criteria.forEach((crit, i) => {
      parts.push(`${i}: ${crit}`);
    });
  }

  if (rubric.score_guide && typeof rubric.score_guide === "object") {
    parts.push("Score guide:");
    const entries = Object.entries(rubric.score_guide).sort(
      ([a], [b]) => Number(b) - Number(a),
    );
    for (const [score, desc] of entries) {
      parts.push(`${score}: ${desc}`);
    }
  }

  return parts.join("\n");
}

export const judgePlugin: CheckPlugin<JudgeOptions> = {
  type: "judge",
  options: JudgeOptionsSchema,
  async run(opts: JudgeOptions, ctx: CheckContext): Promise<CheckResult> {
    const rubricsPath =
      ctx.rubricsPath ??
      path.resolve(ctx.projectDir || process.cwd(), "rubrics.yaml");

    const rubrics = loadRubrics(rubricsPath);
    const rubricDef = rubrics[opts.rubric];
    if (!rubricDef) {
      throw new ConfigError(
        `Rubric "${opts.rubric}" not found in rubrics file: ${rubricsPath}`,
      );
    }

    const rubricText = formatRubricText(rubricDef);
    const inputJson = JSON.stringify(ctx.case.input);
    const expectedStr =
      typeof ctx.case.expect === "string"
        ? ctx.case.expect
        : JSON.stringify(ctx.case.expect ?? "");
    const answerStr = ctx.output.text;

    const messages: Message[] = [
      {
        role: "system",
        content: "You grade one answer against a rubric. Reply with JSON only.",
      },
      {
        role: "user",
        content: [
          "RUBRIC:",
          rubricText,
          `INPUT: ${inputJson}`,
          `EXPECTED: ${expectedStr}`,
          `ANSWER: ${answerStr}`,
          'Return {"score": 1-5, "reason": "<one sentence>", "failed_criteria": [<index>, ...]}',
        ].join("\n"),
      },
    ];

    const model = opts.model ?? "judge";
    const passScore = opts.pass_score ?? 4;
    let totalCostUsd = 0;

    const parseReply = (reply: Reply): JudgeReply | null => {
      try {
        const jsonVal =
          typeof reply.json === "function" ? reply.json() : JSON.parse(reply.text);
        return JudgeReplySchema.parse(jsonVal);
      } catch {
        return null;
      }
    };

    // Attempt 1
    const reply1 = (await ctx.chat(model, messages, {
      temperature: 0,
      tag: "judge",
      json: true,
      signal: ctx.signal,
    })) as Reply;

    if (reply1?.costUsd && typeof reply1.costUsd === "number") {
      totalCostUsd += reply1.costUsd;
    }

    let parsed = parseReply(reply1);

    // If attempt 1 failed to parse, retry once
    if (!parsed) {
      const reply2 = (await ctx.chat(model, messages, {
        temperature: 0,
        tag: "judge",
        json: true,
        signal: ctx.signal,
      })) as Reply;

      if (reply2?.costUsd && typeof reply2.costUsd === "number") {
        totalCostUsd += reply2.costUsd;
      }

      parsed = parseReply(reply2);
    }

    // If still unparseable after one retry
    if (!parsed) {
      return {
        type: "judge",
        passed: false,
        score: null,
        reason: "judge_unparseable",
        costUsd: totalCostUsd,
      };
    }

    const passed = parsed.score >= passScore;
    return {
      type: "judge",
      passed,
      score: parsed.score,
      reason: parsed.reason,
      costUsd: totalCostUsd,
    };
  },
};
