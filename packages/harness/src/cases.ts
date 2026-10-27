import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { getCheck } from "./registry.js";
import type { Case, CaseKind, CheckSpec } from "./types.js";

const ID_REGEX = /^[a-z0-9-]+$/;

const RawCheckSpecSchema = z.object({
  type: z.string().min(1, "Check type is required"),
  field: z.string().optional(),
  negate: z.boolean().optional(),
}).passthrough();

const RawCaseSchema = z.object({
  id: z.string().regex(ID_REGEX, "id must match [a-z0-9-]+"),
  kind: z.enum(["answer", "trace"]).optional().default("answer"),
  input: z.record(z.string(), z.unknown()),
  expect: z.unknown().optional(),
  check: z.preprocess(
    (val) => (val && typeof val === "object" && !Array.isArray(val) ? [val] : val),
    z.array(RawCheckSpecSchema).min(1, "Case must have at least one check"),
  ),
  tags: z.array(z.string()).optional(),
  timeout_s: z.number().positive().optional(),
  skip: z.boolean().optional(),
});

export function validateCase(raw: unknown, source: string): Case {
  const result = RawCaseSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const msg = issue ? `${issue.path.join(".")}: ${issue.message}` : result.error.message;
    throw new ConfigError(`Invalid case in ${source}: ${msg}`);
  }

  const caseObj = result.data as Case;

  // Validate checks against check registry
  for (const check of caseObj.check) {
    const plugin = getCheck(check.type);
    if (!plugin) {
      throw new ConfigError(`Unknown check type "${check.type}" in case "${caseObj.id}" (${source})`);
    }

    if (caseObj.kind === "answer" && plugin.needsTrace) {
      throw new ConfigError(
        `Trace-only check "${check.type}" used in answer case "${caseObj.id}" (${source})`,
      );
    }

    if (plugin.options) {
      const optResult = plugin.options.safeParse(check);
      if (!optResult.success) {
        const issue = optResult.error.issues[0];
        const msg = issue ? `${issue.path.join(".")}: ${issue.message}` : optResult.error.message;
        throw new ConfigError(
          `Bad options for check "${check.type}" in case "${caseObj.id}" (${source}): ${msg}`,
        );
      }
    }
  }

  return caseObj;
}

export function loadCases(casesPath: string, projectDir?: string): Case[] {
  const resolvedPath = path.isAbsolute(casesPath)
    ? casesPath
    : path.resolve(projectDir || process.cwd(), casesPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`Cases path does not exist: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  const files: string[] = [];

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolvedPath).sort();
    for (const entry of entries) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        files.push(path.join(resolvedPath, entry));
      }
    }
  } else {
    files.push(resolvedPath);
  }

  if (files.length === 0) {
    throw new ConfigError(`No YAML case files found at: ${resolvedPath}`);
  }

  const seenIds = new Set<string>();
  const allCases: Case[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      throw new ConfigError(
        `Invalid YAML in file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!Array.isArray(parsed)) {
      throw new ConfigError(`Case file must contain a list of cases: ${file}`);
    }

    for (const item of parsed) {
      const caseObj = validateCase(item, file);

      if (seenIds.has(caseObj.id)) {
        throw new ConfigError(`Duplicate case id "${caseObj.id}" in file ${file}`);
      }
      seenIds.add(caseObj.id);
      allCases.push(caseObj);
    }
  }

  return allCases;
}
