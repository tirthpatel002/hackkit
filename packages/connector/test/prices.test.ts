import { describe, expect, it } from "vitest";
import { calculateCost, getPrice, loadPrices } from "../src/index.js";

describe("prices", () => {
  it("loads price table from prices.yaml", () => {
    const table = loadPrices();
    expect(table["nebius:nvidia/nemotron-3-super-120b-a12b"]).toEqual({
      in: 0.3,
      cached: 0.06,
      out: 0.9,
    });
    expect(table["nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"]).toEqual({
      in: 0.06,
      cached: 0.012,
      out: 0.24,
    });
    expect(table["nebius:nvidia/Nemotron-3-Ultra-550b-a55b"]).toEqual({
      in: 1.0,
      cached: 0.12,
      out: 3.0,
    });
    expect(table["nebius:nvidia/Nemotron-3.5-Super-VL"]).toEqual({
      in: 0.3,
      cached: 0.06,
      out: 0.9,
    });
    expect(table["nebius:Qwen/Qwen3-Embedding-8B"]).toEqual({
      in: 0.01,
      cached: 0.01,
      out: 0.0,
    });
    expect(table["meta:muse-spark-1.3"]).toEqual({
      in: 1.25,
      cached: 0.15,
      out: 4.25,
    });
    expect(table["meta:muse-spark-1.2"]).toEqual({
      in: 1.25,
      cached: 0.15,
      out: 4.25,
    });
    expect(table["meta:muse-wonder-1.0"]).toEqual({
      in: 4.0,
      cached: 0.2,
      out: 20.0,
    });
  });

  it("calculates cost per price row with no cached tokens", () => {
    // 812 in, 164 out for nemotron-3-super-120b-a12b
    // (812 * 0.30 + 164 * 0.90) / 1,000,000 = (243.6 + 147.6) / 1,000,000 = 0.0003912
    const res = calculateCost("nebius:nvidia/nemotron-3-super-120b-a12b", 812, 164, 0);
    expect(res.priceMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.0003912, 7);
  });

  it("calculates cost with cached tokens properly", () => {
    // 1000 in, 400 cached, 200 out
    // uncached = 600
    // cost = (600 * 0.30 + 400 * 0.06 + 200 * 0.90) / 1,000,000 = (180 + 24 + 180) / 1,000,000 = 0.000384
    const res = calculateCost("nebius:nvidia/nemotron-3-super-120b-a12b", 1000, 200, 400);
    expect(res.priceMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.000384, 7);
  });

  it("calculates cost for nano model row", () => {
    // 1000 in, 1000 out: (1000 * 0.06 + 1000 * 0.24) / 1,000,000 = 0.3 / 1000 = 0.0003
    const res = calculateCost("nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 1000, 1000, 0);
    expect(res.priceMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.0003, 6);
  });

  it("calculates cost for embedding model row", () => {
    // 100,000 tokens in: (100,000 * 0.01) / 1,000,000 = 0.001
    const res = calculateCost("nebius:Qwen/Qwen3-Embedding-8B", 100_000, 0, 0);
    expect(res.priceMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.001, 6);
  });

  it("calculates cost for Meta Muse Spark row", () => {
    // 10,000 in, 2000 out: (10000 * 1.25 + 2000 * 4.25) / 1,000,000 = (12500 + 8500) / 1,000,000 = 0.021
    const res = calculateCost("meta:muse-spark-1.3", 10_000, 2000, 0);
    expect(res.priceMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.021, 6);
  });

  it("returns 0 cost and priceMissing flag when price is not in table", () => {
    const res = calculateCost("unknown:model-xyz", 1000, 1000, 0);
    expect(res.costUsd).toBe(0);
    expect(res.priceMissing).toBe(true);
  });

  it("returns null cost for agy-cli models without priceMissing warning", () => {
    const res = calculateCost("agy-cli:gemini-3.8-flash-high", 500, 500, 0);
    expect(res.costUsd).toBeNull();
    expect(res.priceMissing).toBe(false);
  });

  it("returns null cost when tokens are null", () => {
    const res = calculateCost("nebius:nvidia/nemotron-3-super-120b-a12b", null, null, null);
    expect(res.costUsd).toBeNull();
    expect(res.priceMissing).toBe(false);
  });
});
