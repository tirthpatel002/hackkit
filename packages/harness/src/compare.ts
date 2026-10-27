import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors.js";
import { ResultsFileSchema, type CompareResult, type ResultsFile } from "./types.js";

export function loadResultsFile(filePath: string): ResultsFile {
  let resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    // If running from packages/harness, try resolving from repo root
    const alt1 = path.resolve(process.cwd(), "../..", filePath);
    const alt2 = path.resolve(process.cwd(), "..", filePath);
    if (fs.existsSync(alt1)) {
      resolved = alt1;
    } else if (fs.existsSync(alt2)) {
      resolved = alt2;
    }
  }

  if (!fs.existsSync(resolved)) {
    throw new ConfigError(`Results file not found: ${resolved}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Could not read results file ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ConfigError(
      `Invalid JSON in results file ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parseResult = ResultsFileSchema.safeParse(raw);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const msg = issue ? `${issue.path.join(".")}: ${issue.message}` : parseResult.error.message;
    throw new ConfigError(`Results file does not conform to schema in ${resolved}: ${msg}`);
  }

  return parseResult.data as ResultsFile;
}

export function formatCompareOutput(
  result: CompareResult,
  relativeOutPath: string,
): string {
  const padRight = (s: string, len: number) => s.padEnd(len, " ");

  const formatPts = (n: number) => (n > 0 ? `+${n.toFixed(1)} pts` : `${n.toFixed(1)} pts`);
  const formatPct = (n: number) => (n > 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`);

  const col0Width = 17;
  const col1Width = 12;
  const col2Width = 18;

  const header =
    padRight("", col0Width) +
    padRight(`A (${result.a.model})`, col1Width) +
    padRight(`B (${result.b.model})`, col2Width) +
    "change";

  const passRateRow =
    padRight("pass rate", col0Width) +
    padRight(`${(result.passRate.a * 100).toFixed(1)}%`, col1Width) +
    padRight(`${(result.passRate.b * 100).toFixed(1)}%`, col2Width) +
    formatPts(result.passRate.deltaPts);

  const costRow =
    padRight("cost", col0Width) +
    padRight(`$${result.cost.a.toFixed(4)}`, col1Width) +
    padRight(`$${result.cost.b.toFixed(4)}`, col2Width) +
    formatPct(result.cost.deltaPct);

  const wallTimeRow =
    padRight("wall time", col0Width) +
    padRight(`${result.wallTime.a.toFixed(1)}s`, col1Width) +
    padRight(`${result.wallTime.b.toFixed(1)}s`, col2Width) +
    formatPct(result.wallTime.deltaPct);

  const fixedStr = result.fixed.length > 0 ? result.fixed.join(", ") : "none";
  const brokeStr = result.broke.length > 0 ? result.broke.join(", ") : "none";
  const stillFailingStr =
    result.stillFailing.length > 0 ? result.stillFailing.join(", ") : "none";

  const onlyStr =
    result.onlyInA.length === 0 && result.onlyInB.length === 0
      ? "only in A / only in B: none"
      : `only in A:            ${result.onlyInA.length > 0 ? result.onlyInA.join(", ") : "none"}\nonly in B:            ${result.onlyInB.length > 0 ? result.onlyInB.join(", ") : "none"}`;

  const lines = [
    header,
    passRateRow,
    costRow,
    wallTimeRow,
    `fixed   (fail->pass): ${fixedStr}`,
    `broke   (pass->fail): ${brokeStr}`,
    `still failing:        ${stillFailingStr}`,
    onlyStr,
  ];

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      lines.push(`Warning: ${w}`);
    }
  }

  lines.push(`# also written as ${relativeOutPath}`);
  return lines.join("\n");
}

export async function compare(aPath: string, bPath: string): Promise<CompareResult> {
  const fileA = loadResultsFile(aPath);
  const fileB = loadResultsFile(bPath);

  // Deltas
  const passRateA = fileA.summary.pass_rate;
  const passRateB = fileB.summary.pass_rate;
  const deltaPts = Number(((passRateB - passRateA) * 100).toFixed(1));

  const costA = fileA.summary.cost_usd;
  const costB = fileB.summary.cost_usd;
  const costPct =
    costA === 0
      ? costB === 0 ? 0 : 100
      : Number((((costB - costA) / costA) * 100).toFixed(1));

  const wallTimeA = fileA.summary.wall_time_s;
  const wallTimeB = fileB.summary.wall_time_s;
  const wallTimePct =
    wallTimeA === 0
      ? wallTimeB === 0 ? 0 : 100
      : Number((((wallTimeB - wallTimeA) / wallTimeA) * 100).toFixed(1));

  // Cases comparison
  const casesA = new Map(fileA.cases.map((c) => [c.id, c]));
  const casesB = new Map(fileB.cases.map((c) => [c.id, c]));

  const fixed: string[] = [];
  const broke: string[] = [];
  const stillFailing: string[] = [];
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];

  for (const [id, cA] of casesA) {
    const cB = casesB.get(id);
    if (!cB) {
      onlyInA.push(id);
      continue;
    }

    const passedA = cA.passed && cA.error === null;
    const passedB = cB.passed && cB.error === null;

    if (!passedA && passedB) {
      fixed.push(id);
    } else if (passedA && !passedB) {
      broke.push(id);
    } else if (!passedA && !passedB) {
      stillFailing.push(id);
    }
  }

  for (const id of casesB.keys()) {
    if (!casesA.has(id)) {
      onlyInB.push(id);
    }
  }

  // Warnings
  const warnings: string[] = [];
  if (onlyInA.length > 0 || onlyInB.length > 0) {
    warnings.push(
      `Different case sets: ${onlyInA.length} only in A (${onlyInA.join(", ") || "none"}), ${onlyInB.length} only in B (${onlyInB.join(", ") || "none"})`,
    );
  }

  if (fileA.judge_model && fileB.judge_model && fileA.judge_model !== fileB.judge_model) {
    warnings.push(
      `Different judge models: "${fileA.judge_model}" vs "${fileB.judge_model}"`,
    );
  }

  // Determine output path
  const aBase = path.basename(aPath, path.extname(aPath));
  const bBase = path.basename(bPath, path.extname(bPath));
  const outFileName = `compare_${aBase}_vs_${bBase}.json`;

  const absA = path.resolve(process.cwd(), aPath);
  const absB = path.resolve(process.cwd(), bPath);
  const dirA = path.dirname(absA);
  const dirB = path.dirname(absB);

  let outDir: string;
  if (path.basename(dirA) === "results") {
    outDir = dirA;
  } else if (path.basename(dirB) === "results") {
    outDir = dirB;
  } else {
    outDir = path.resolve(process.cwd(), "results");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, outFileName);
  const relativeOutPath = path.relative(process.cwd(), outPath);

  const compareJson = {
    a: {
      file: aPath,
      model: fileA.model,
      judge_model: fileA.judge_model,
      pass_rate: passRateA,
      cost_usd: costA,
      wall_time_s: wallTimeA,
    },
    b: {
      file: bPath,
      model: fileB.model,
      judge_model: fileB.judge_model,
      pass_rate: passRateB,
      cost_usd: costB,
      wall_time_s: wallTimeB,
    },
    delta: {
      pass_rate_pts: deltaPts,
      cost_pct: costPct,
      wall_time_pct: wallTimePct,
    },
    fixed,
    broke,
    still_failing: stillFailing,
    only_in_a: onlyInA,
    only_in_b: onlyInB,
    warnings,
  };

  fs.writeFileSync(outPath, JSON.stringify(compareJson, null, 2), "utf8");

  const result: CompareResult = {
    a: fileA,
    b: fileB,
    passRate: { a: passRateA, b: passRateB, deltaPts },
    cost: { a: costA, b: costB, deltaPct: costPct },
    wallTime: { a: wallTimeA, b: wallTimeB, deltaPct: wallTimePct },
    fixed,
    broke,
    stillFailing,
    onlyInA,
    onlyInB,
    warnings,
    outPath,
  };

  const report = formatCompareOutput(result, relativeOutPath);
  console.log(report);

  return result;
}
