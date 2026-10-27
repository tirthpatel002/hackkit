import { describe, expect, it } from "vitest";
import {
  calculatePercentile,
  createRunId,
  formatIsoIst,
} from "../src/report.js";
import { ResultsFileSchema } from "../src/types.js";

describe("results JSON and formatting", () => {
  it("results JSON matches ResultsFileSchema", () => {
    const sampleResults = {
      schema: 1,
      project: "echo",
      run_id: "2026-10-28T1130_main",
      started_at: "2026-10-28T11:30:02+05:30",
      git_sha: "a1b2c3d",
      model: "main",
      judge_model: "judge",
      cases_file: "cases/",
      concurrency: 8,
      summary: {
        total: 20,
        passed: 17,
        failed: 2,
        errored: 1,
        skipped: 0,
        pass_rate: 0.85,
        cost_usd: 0.0412,
        judge_cost_usd: 0.0108,
        wall_time_s: 71.4,
        p50_case_ms: 2900,
        p95_case_ms: 8800,
      },
      cases: [
        {
          id: "echo-002-capital",
          kind: "answer",
          passed: true,
          cost_usd: 0.0009,
          judge_cost_usd: 0.0,
          time_ms: 2410,
          error: null,
          checks: [
            {
              type: "contains",
              passed: true,
              score: null,
              reason: "",
            },
          ],
          output: "Paris.",
        },
      ],
    };

    const parsed = ResultsFileSchema.parse(sampleResults);
    expect(parsed.schema).toBe(1);
    expect(parsed.summary.total).toBe(20);
    expect(parsed.cases[0]?.id).toBe("echo-002-capital");
  });

  it("calculates p50 and p95 correctly", () => {
    const times = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const p50 = calculatePercentile(times, 50);
    const p95 = calculatePercentile(times, 95);
    expect(p50).toBe(600);
    expect(p95).toBe(1000);
  });

  it("formats ISO date with IST offset (+05:30)", () => {
    const date = new Date("2026-10-28T06:00:00Z"); // 06:00 UTC = 11:30 IST
    const formatted = formatIsoIst(date);
    expect(formatted).toContain("+05:30");
    expect(formatted).toContain("11:30:00");
  });

  it("creates valid run_id format YYYY-MM-DDTHHMM_<model>", () => {
    const date = new Date("2026-10-28T06:00:00Z");
    const runId = createRunId("main", date);
    expect(runId).toBe("2026-10-28T1130_main");
  });
});
