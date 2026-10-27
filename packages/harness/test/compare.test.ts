import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { compare, formatCompareOutput, loadResultsFile } from "../src/compare.js";
import { ConfigError } from "../src/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "fixtures");
const fileA = path.join(fixtureDir, "results-A.json");
const fileB = path.join(fixtureDir, "results-B.json");
const diffA = path.join(fixtureDir, "results-diff-cases-A.json");
const diffB = path.join(fixtureDir, "results-diff-cases-B.json");

describe("compare", () => {
  it("loads a results file without kind or concurrency (older Schema 1)", () => {
    const loadedA = loadResultsFile(fileA);
    expect(loadedA.schema).toBe(1);
    expect(loadedA.cases[0]?.id).toBe("echo-001-shout");
    expect(loadedA.cases[0]?.kind).toBe("answer"); // defaulted to answer
    expect(loadedA.concurrency).toBeUndefined();
  });

  it("finds fixed, broke, and still failing on two fixture files and writes compare JSON", async () => {
    const result = await compare(fileA, fileB);

    expect(result.passRate.a).toBe(0.5);
    expect(result.passRate.b).toBe(0.5);
    expect(result.passRate.deltaPts).toBe(0.0);

    expect(result.cost.a).toBe(0.039);
    expect(result.cost.b).toBe(0.0412);
    expect(result.cost.deltaPct).toBeCloseTo(5.6, 1);

    expect(result.wallTime.a).toBe(68.2);
    expect(result.wallTime.b).toBe(71.4);
    expect(result.wallTime.deltaPct).toBeCloseTo(4.7, 1);

    expect(result.fixed).toEqual(["echo-003-explain"]);
    expect(result.broke).toEqual(["echo-001-shout"]);
    expect(result.stillFailing).toEqual(["echo-014-long-input"]);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual([]);
    expect(result.warnings).toEqual([]);

    expect(fs.existsSync(result.outPath)).toBe(true);
    const writtenJson = JSON.parse(fs.readFileSync(result.outPath, "utf8"));
    expect(writtenJson.fixed).toEqual(["echo-003-explain"]);
    expect(writtenJson.broke).toEqual(["echo-001-shout"]);
    expect(writtenJson.still_failing).toEqual(["echo-014-long-input"]);
  });

  it("warns on different case sets and different judge models", async () => {
    const result = await compare(diffA, diffB);

    expect(result.onlyInA).toEqual(["case-only-in-a"]);
    expect(result.onlyInB).toEqual(["case-only-in-b"]);
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.some((w) => w.includes("Different case sets"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Different judge models"))).toBe(true);
  });

  it("formats compare output with metrics, case lists, and warnings", async () => {
    const result = await compare(fileA, fileB);
    const output = formatCompareOutput(result, "results/compare.json");

    expect(output).toContain("pass rate");
    expect(output).toContain("cost");
    expect(output).toContain("wall time");
    expect(output).toContain("fixed   (fail->pass): echo-003-explain");
    expect(output).toContain("broke   (pass->fail): echo-001-shout");
    expect(output).toContain("still failing:        echo-014-long-input");
    expect(output).toContain("only in A / only in B: none");
    expect(output).toContain("# also written as results/compare.json");
  });

  it("runs via harness compare CLI command and returns exit code 0", async () => {
    const code = await main(["compare", fileA, fileB]);
    expect(code).toBe(0);
  });

  it("throws ConfigError when arguments are missing in CLI compare command", async () => {
    await expect(main(["compare", fileA])).rejects.toThrow(ConfigError);
  });
});
