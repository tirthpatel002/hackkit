import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { loadCases } from "./cases.js";
import { ConfigError } from "./errors.js";
import { runPool } from "./pool.js";
import { getCheck } from "./registry.js";
import {
  calculateCost,
  calculatePercentile,
  createRunId,
  formatIsoIst,
  formatTerminalReport,
  getGitSha,
  loadCallCosts,
  writeResultsJson,
} from "./report.js";
import type {
  Case,
  CaseOutput,
  CaseResult,
  CaseResultJson,
  ChatFn,
  CheckResult,
  HarnessConfig,
  ResultsFile,
  ResultsSummary,
  RunCase,
  RunOptions,
} from "./types.js";

export const stubChat: ChatFn = async () => {
  throw new Error("Chat is not available in H1; connector will be wired in H2");
};

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

export function resolveProjectDir(projectArg: string): string {
  // 1. Direct path
  const abs = path.resolve(process.cwd(), projectArg);
  if (fs.existsSync(abs)) {
    if (fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, "harness.yaml"))) {
      return abs;
    }
    if (fs.statSync(abs).isFile() && path.basename(abs) === "harness.yaml") {
      return path.dirname(abs);
    }
  }

  // 2. ./<projectArg>
  const rel1 = path.resolve(process.cwd(), "./" + projectArg);
  if (fs.existsSync(rel1) && fs.existsSync(path.join(rel1, "harness.yaml"))) {
    return rel1;
  }

  // 3. ../<projectArg>
  const rel2 = path.resolve(process.cwd(), "../" + projectArg);
  if (fs.existsSync(rel2) && fs.existsSync(path.join(rel2, "harness.yaml"))) {
    return rel2;
  }

  throw new ConfigError(`Cannot find project directory with harness.yaml for: "${projectArg}"`);
}

export async function loadCheckPlugins(
  plugins: string[] | undefined,
  projectDir: string,
): Promise<void> {
  if (!plugins || plugins.length === 0) return;
  for (const pluginPath of plugins) {
    const resolvedPath = path.isAbsolute(pluginPath)
      ? pluginPath
      : path.resolve(projectDir, pluginPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new ConfigError(`Check plugin not found: ${resolvedPath}`);
    }

    const fileUrl = pathToFileURL(resolvedPath).href;
    try {
      await import(fileUrl);
    } catch (err) {
      throw new ConfigError(
        `Failed to import check plugin ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function loadAdapter(adapterSpec: string, projectDir: string): Promise<RunCase> {
  const colonIndex = adapterSpec.lastIndexOf(":");
  if (colonIndex === -1 || colonIndex === 0 || colonIndex === adapterSpec.length - 1) {
    throw new ConfigError(`Invalid adapter spec: "${adapterSpec}". Expected format "file.ts:exportName"`);
  }
  const filePath = adapterSpec.slice(0, colonIndex);
  const exportName = adapterSpec.slice(colonIndex + 1);

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir, filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`Adapter module not found: ${resolvedPath}`);
  }

  const fileUrl = pathToFileURL(resolvedPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(fileUrl)) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to load adapter module ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const fn = mod[exportName];
  if (typeof fn !== "function") {
    throw new ConfigError(`Export "${exportName}" not found or not a function in adapter ${resolvedPath}`);
  }

  return fn as RunCase;
}

export function loadHarnessConfig(projectDir: string): HarnessConfig {
  const configPath = path.join(projectDir, "harness.yaml");
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`harness.yaml not found at ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (err) {
    throw new ConfigError(
      `Invalid YAML in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`harness.yaml must be a YAML mapping in ${configPath}`);
  }

  const cfg = parsed as Record<string, unknown>;
  if (typeof cfg.adapter !== "string" || !cfg.adapter) {
    throw new ConfigError(`harness.yaml missing required string field "adapter" in ${configPath}`);
  }

  const harnessConfig: HarnessConfig = {
    adapter: cfg.adapter,
    ...(typeof cfg.agent_adapter === "string" ? { agent_adapter: cfg.agent_adapter } : {}),
    ...(Array.isArray(cfg.check_plugins)
      ? { check_plugins: cfg.check_plugins as string[] }
      : {}),
    ...(typeof cfg.cases === "string" ? { cases: cfg.cases } : {}),
    ...(typeof cfg.concurrency === "number" ? { concurrency: cfg.concurrency } : {}),
    ...(typeof cfg.case_timeout_s === "number"
      ? { case_timeout_s: cfg.case_timeout_s }
      : {}),
    ...(typeof cfg.judge_model === "string" ? { judge_model: cfg.judge_model } : {}),
    ...(typeof cfg.rubrics === "string" ? { rubrics: cfg.rubrics } : {}),
  };

  return harnessConfig;
}

export async function run(project: string, opts?: RunOptions): Promise<ResultsFile> {
  const startedDate = new Date();
  const startTimeMs = Date.now();

  const projectDir = resolveProjectDir(project);
  const config = loadHarnessConfig(projectDir);

  // 1. Import check_plugins before cases load
  await loadCheckPlugins(config.check_plugins, projectDir);

  // 2. Load cases
  const casesFile = opts?.casesFile ?? config.cases ?? "cases/";
  let cases = loadCases(casesFile, projectDir);

  // Filter by tags if requested
  if (opts?.tags && opts.tags.length > 0) {
    cases = cases.filter((c) => c.tags?.some((t) => opts.tags!.includes(t)));
  }

  // Reject trace cases in H1
  for (const c of cases) {
    if (c.kind === "trace") {
      throw new ConfigError(
        `Trace cases are not supported in H1 (case "${c.id}"); trace cases come in X1`,
      );
    }
  }

  // 3. Load adapter
  const adapter = await loadAdapter(config.adapter, projectDir);

  // 4. Concurrency & Timeout
  const concurrency = opts?.concurrency ?? config.concurrency ?? 8;
  const defaultTimeoutS = config.case_timeout_s ?? 30;
  const model = opts?.model ?? "main";

  // 5. Load call logs for cost calculation
  const projectLogsPath = path.join(projectDir, "logs", "calls.jsonl");
  const cwdLogsPath = path.resolve(process.cwd(), "logs", "calls.jsonl");
  const logFilePath = fs.existsSync(projectLogsPath) ? projectLogsPath : cwdLogsPath;
  const callCosts = loadCallCosts(logFilePath);

  // 6. Run cases through the worker pool
  const caseResults = await runPool<Case, CaseResult>({
    items: cases,
    concurrency,
    getTimeoutMs: (c) => (c.timeout_s ?? defaultTimeoutS) * 1000,
    task: async (caseObj, { signal }) => {
      if (caseObj.skip) {
        return {
          id: caseObj.id,
          kind: "answer",
          passed: false,
          checks: [],
          output: "",
          costUsd: 0,
          judgeCostUsd: 0,
          timeMs: 0,
          error: null,
          cost_usd: 0,
          judge_cost_usd: 0,
          time_ms: 0,
        };
      }

      const caseStartMs = Date.now();
      const caseOutput = await adapter(caseObj.input, { model, signal });
      const elapsedMs = Date.now() - caseStartMs;

      const checks: CheckResult[] = [];
      for (const checkSpec of caseObj.check) {
        const fieldValue = resolveField(caseOutput, checkSpec.field ?? "text");
        const targetText = typeof fieldValue === "string" ? fieldValue : String(fieldValue ?? "");
        const checkOutput: CaseOutput = { ...caseOutput, text: targetText };

        const plugin = getCheck(checkSpec.type);
        if (!plugin) {
          throw new ConfigError(`Unknown check type "${checkSpec.type}"`);
        }

        let result = await plugin.run(checkSpec, {
          case: caseObj,
          output: checkOutput,
          chat: stubChat,
          signal,
          projectDir,
        });

        if (checkSpec.negate) {
          const passed = !result.passed;
          result = {
            ...result,
            passed,
            reason: passed
              ? (result.reason ? `(negated) ${result.reason}` : "")
              : (result.reason || `Negated check ${checkSpec.type} failed`),
          };
        }

        checks.push(result);
      }

      const passed = checks.length > 0 && checks.every((c) => c.passed);
      const costUsd = calculateCost(caseOutput.callIds, callCosts);
      const truncatedOutput = caseOutput.text.slice(0, 2000);

      return {
        id: caseObj.id,
        kind: "answer",
        passed,
        checks,
        output: truncatedOutput,
        costUsd,
        judgeCostUsd: 0,
        timeMs: elapsedMs,
        error: null,
        cost_usd: costUsd,
        judge_cost_usd: 0,
        time_ms: elapsedMs,
      };
    },
    onTimeout: (caseObj) => {
      const timeoutMs = (caseObj.timeout_s ?? defaultTimeoutS) * 1000;
      return {
        id: caseObj.id,
        kind: "answer",
        passed: false,
        checks: [],
        output: "",
        costUsd: 0,
        judgeCostUsd: 0,
        timeMs: timeoutMs,
        error: "timeout",
        cost_usd: 0,
        judge_cost_usd: 0,
        time_ms: timeoutMs,
      };
    },
    onError: (caseObj, _, err) => {
      const errorStr = err instanceof Error ? err.message : String(err);
      return {
        id: caseObj.id,
        kind: "answer",
        passed: false,
        checks: [],
        output: "",
        costUsd: 0,
        judgeCostUsd: 0,
        timeMs: 0,
        error: errorStr,
        cost_usd: 0,
        judge_cost_usd: 0,
        time_ms: 0,
      };
    },
  });

  const wallTimeS = (Date.now() - startTimeMs) / 1000;
  const total = caseResults.length;
  const passed = caseResults.filter((c) => c.passed).length;
  const errored = caseResults.filter((c) => c.error !== null).length;
  const skippedCases = new Set(cases.filter((c) => c.skip).map((c) => c.id));
  const skipped = skippedCases.size;
  const failed = caseResults.filter(
    (c) => !c.passed && c.error === null && !skippedCases.has(c.id),
  ).length;
  const passRate = total > 0 ? passed / total : 0;
  const totalCostUsd = caseResults.reduce((acc, c) => acc + c.costUsd, 0);
  const totalJudgeCostUsd = 0;

  const caseTimes = caseResults.map((c) => c.timeMs);
  const p50 = calculatePercentile(caseTimes, 50);
  const p95 = calculatePercentile(caseTimes, 95);

  const summary: ResultsSummary = {
    total,
    passed,
    failed,
    errored,
    skipped,
    pass_rate: Number(passRate.toFixed(4)),
    cost_usd: Number(totalCostUsd.toFixed(6)),
    judge_cost_usd: Number(totalJudgeCostUsd.toFixed(6)),
    wall_time_s: Number(wallTimeS.toFixed(2)),
    p50_case_ms: p50,
    p95_case_ms: p95,
  };

  const casesJson: CaseResultJson[] = caseResults.map((c) => ({
    id: c.id,
    kind: c.kind,
    passed: c.passed,
    cost_usd: c.costUsd,
    judge_cost_usd: c.judgeCostUsd,
    time_ms: c.timeMs,
    error: c.error,
    checks: c.checks.map((chk) => ({
      type: chk.type,
      passed: chk.passed,
      score: chk.score,
      reason: chk.reason,
      ...(chk.costUsd !== undefined ? { costUsd: chk.costUsd } : {}),
    })),
    output: c.output,
    ...(c.steps !== undefined ? { steps: c.steps } : {}),
  }));

  const projectName = path.basename(projectDir);
  const runId = createRunId(model, startedDate);
  const resultsFile: ResultsFile = {
    schema: 1,
    project: projectName,
    run_id: runId,
    started_at: formatIsoIst(startedDate),
    git_sha: getGitSha(projectDir),
    model,
    judge_model: config.judge_model ?? "judge",
    cases_file: casesFile,
    concurrency,
    summary,
    cases: casesJson,
  };

  // 7. Output terminal table and write JSON
  const reportOutput = formatTerminalReport(caseResults, summary);
  console.log(reportOutput);

  writeResultsJson(projectDir, resultsFile);

  return resultsFile;
}
