import { z } from "zod";

// ---- cases ----
export type CaseKind = "answer" | "trace";

export interface CheckSpec {
  type: string;
  field?: string;
  negate?: boolean;
  [option: string]: unknown;
}

export interface Case {
  id: string;
  kind?: CaseKind;
  input: Record<string, unknown>;
  expect?: unknown;
  check: CheckSpec[];
  tags?: string[];
  timeout_s?: number;
  skip?: boolean;
}

// ---- adapters ----
export interface CaseOutput {
  text: string;
  data?: Record<string, unknown>;
  callIds?: string[];
}

export type RunCase = (
  input: Record<string, unknown>,
  ctx: { model?: string; signal: AbortSignal }
) => Promise<CaseOutput>;

export interface TraceStep {
  seq: number;
  type: "step" | "tool_call" | "tool_result" | "error" | (string & {});
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface AgentTrace {
  steps: TraceStep[];
  final: CaseOutput;
}

export type RunAgent = (
  input: Record<string, unknown>,
  ctx: { model?: string; signal: AbortSignal; maxSteps?: number }
) => Promise<AgentTrace>;

// ---- checks ----
export interface CheckResult {
  type: string;
  passed: boolean;
  score: number | null;
  reason: string;
  costUsd?: number;
}

/** Local minimal ChatFn definition for H1. H2 will wire @hackkit/connector. */
export type ChatFn = (model: string, messages: unknown[], opts?: unknown) => Promise<unknown>;

export interface CheckContext {
  case: Case;
  output: CaseOutput;
  trace?: AgentTrace;
  chat: ChatFn;
  signal: AbortSignal;
  projectDir?: string;
}

export interface CheckPlugin<O = Record<string, unknown>> {
  type: string;
  options?: z.ZodType<O>;
  needsTrace?: boolean;
  run(opts: O, ctx: CheckContext): Promise<CheckResult> | CheckResult;
}

// ---- results ----
export interface CaseResult {
  id: string;
  kind: CaseKind;
  passed: boolean;
  checks: CheckResult[];
  output: string;
  steps?: number;
  costUsd: number;
  judgeCostUsd: number;
  timeMs: number;
  error: string | null;
  // File format aliases for convenience
  cost_usd?: number;
  judge_cost_usd?: number;
  time_ms?: number;
}

export interface CaseResultJson {
  id: string;
  kind: CaseKind;
  passed: boolean;
  cost_usd: number;
  judge_cost_usd: number;
  time_ms: number;
  error: string | null;
  checks: CheckResult[];
  output: string;
  steps?: number;
}

export interface ResultsSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  pass_rate: number;
  cost_usd: number;
  judge_cost_usd: number;
  wall_time_s: number;
  p50_case_ms: number;
  p95_case_ms: number;
}

export interface ResultsFile {
  schema: 1;
  project: string;
  run_id: string;
  started_at: string;
  git_sha: string;
  model: string;
  judge_model: string;
  cases_file: string;
  concurrency?: number;
  summary: ResultsSummary;
  cases: CaseResultJson[];
}

export interface RunOptions {
  casesFile?: string;
  model?: string;
  concurrency?: number;
  tags?: string[];
}

export interface HarnessConfig {
  adapter: string;
  agent_adapter?: string;
  check_plugins?: string[];
  cases?: string;
  concurrency?: number;
  case_timeout_s?: number;
  judge_model?: string;
  rubrics?: string;
}

// ---- Zod schemas for results validation ----
export const CheckResultSchema = z.object({
  type: z.string(),
  passed: z.boolean(),
  score: z.number().nullable(),
  reason: z.string(),
  costUsd: z.number().optional(),
});

export const CaseResultJsonSchema = z.object({
  id: z.string(),
  kind: z.enum(["answer", "trace"]),
  passed: z.boolean(),
  cost_usd: z.number(),
  judge_cost_usd: z.number(),
  time_ms: z.number(),
  error: z.string().nullable(),
  checks: z.array(CheckResultSchema),
  output: z.string(),
  steps: z.number().optional(),
});

export const ResultsSummarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  skipped: z.number(),
  pass_rate: z.number(),
  cost_usd: z.number(),
  judge_cost_usd: z.number(),
  wall_time_s: z.number(),
  p50_case_ms: z.number(),
  p95_case_ms: z.number(),
});

export const ResultsFileSchema = z.object({
  schema: z.literal(1),
  project: z.string(),
  run_id: z.string(),
  started_at: z.string(),
  git_sha: z.string(),
  model: z.string(),
  judge_model: z.string(),
  cases_file: z.string(),
  concurrency: z.number().optional(),
  summary: ResultsSummarySchema,
  cases: z.array(CaseResultJsonSchema),
});
