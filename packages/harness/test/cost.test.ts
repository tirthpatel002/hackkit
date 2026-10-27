import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateCost, loadCallCosts } from "../src/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("cost calculation", () => {
  const fixtureLogPath = path.resolve(__dirname, "fixtures/calls.jsonl");

  it("loads call costs from calls.jsonl fixture including null", () => {
    const costs = loadCallCosts(fixtureLogPath);
    expect(costs.get("c_call1")).toBe(0.0012);
    expect(costs.get("c_call2")).toBe(0); // null converted to 0
    expect(costs.get("c_call3")).toBe(0.0035);
    expect(costs.get("c_call4")).toBe(0);
  });

  it("sums costs for given callIds", () => {
    const costs = loadCallCosts(fixtureLogPath);

    const total1 = calculateCost(["c_call1", "c_call3"], costs);
    expect(Number(total1.toFixed(6))).toBe(0.0047);

    const total2 = calculateCost(["c_call1", "c_call2"], costs);
    expect(Number(total2.toFixed(6))).toBe(0.0012);

    const total3 = calculateCost(["c_call2", "c_call4"], costs);
    expect(total3).toBe(0);
  });

  it("handles missing callIds and unknown calls gracefully", () => {
    const costs = loadCallCosts(fixtureLogPath);
    expect(calculateCost(undefined, costs)).toBe(0);
    expect(calculateCost([], costs)).toBe(0);
    expect(calculateCost(["c_unknown_id"], costs)).toBe(0);
  });

  it("returns empty map if file does not exist", () => {
    const costs = loadCallCosts("nonexistent/calls.jsonl");
    expect(costs.size).toBe(0);
    expect(calculateCost(["c_call1"], costs)).toBe(0);
  });
});
