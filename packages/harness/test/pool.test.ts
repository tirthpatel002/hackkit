import { describe, expect, it } from "vitest";
import { runPool } from "../src/pool.js";

describe("worker pool", () => {
  it("concurrency 3 on 10 fake cases with random delay never exceeds 3 in flight and keeps load order over 5 runs", async () => {
    const fakeCases = Array.from({ length: 10 }, (_, i) => ({
      id: `case-${i}`,
      index: i,
    }));

    for (let run = 0; run < 5; run++) {
      let maxInFlight = 0;

      const results = await runPool({
        items: fakeCases,
        concurrency: 3,
        defaultTimeoutMs: 5000,
        onInFlightChange: (inFlight) => {
          if (inFlight > maxInFlight) {
            maxInFlight = inFlight;
          }
        },
        task: async (item) => {
          // Random delay between 5ms and 30ms
          const delay = Math.floor(Math.random() * 25) + 5;
          await new Promise((r) => setTimeout(r, delay));
          return { id: item.id, finishedIndex: item.index };
        },
      });

      expect(maxInFlight).toBeLessThanOrEqual(3);
      expect(results.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(results[i]?.id).toBe(`case-${i}`);
        expect(results[i]?.finishedIndex).toBe(i);
      }
    }
  });

  it("timeout marks only that case errored and aborts its signal", async () => {
    const abortedSignals: boolean[] = [];

    const items = [
      { id: "case-fast-1", timeoutMs: 200, delayMs: 10 },
      { id: "case-timeout", timeoutMs: 50, delayMs: 300 },
      { id: "case-fast-2", timeoutMs: 200, delayMs: 10 },
    ];

    const results = await runPool({
      items,
      concurrency: 2,
      getTimeoutMs: (item) => item.timeoutMs,
      task: async (item, { signal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, item.delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              abortedSignals.push(signal.aborted);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { id: item.id, passed: true, error: null };
      },
      onTimeout: (item) => ({ id: item.id, passed: false, error: "timeout" }),
      onError: (item, _, err) => ({
        id: item.id,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    });

    expect(results[0]?.id).toBe("case-fast-1");
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.error).toBeNull();

    expect(results[1]?.id).toBe("case-timeout");
    expect(results[1]?.passed).toBe(false);
    expect(results[1]?.error).toBe("timeout");

    expect(results[2]?.id).toBe("case-fast-2");
    expect(results[2]?.passed).toBe(true);
    expect(results[2]?.error).toBeNull();

    expect(abortedSignals).toContain(true);
  });

  it("adapter rejection is captured as error string without crashing the pool", async () => {
    const items = [
      { id: "case-ok-1", fail: false },
      { id: "case-reject", fail: true },
      { id: "case-ok-2", fail: false },
    ];

    const results = await runPool({
      items,
      concurrency: 2,
      task: async (item) => {
        if (item.fail) {
          throw new Error("Adapter connection dropped");
        }
        return { id: item.id, passed: true, error: null };
      },
      onTimeout: (item) => ({ id: item.id, passed: false, error: "timeout" }),
      onError: (item, _, err) => ({
        id: item.id,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    });

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.error).toBeNull();

    expect(results[1]?.passed).toBe(false);
    expect(results[1]?.error).toBe("Adapter connection dropped");

    expect(results[2]?.passed).toBe(true);
    expect(results[2]?.error).toBeNull();
  });
});
