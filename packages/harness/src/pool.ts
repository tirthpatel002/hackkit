export interface PoolTaskContext {
  signal: AbortSignal;
  index: number;
}

export type PoolTask<T, R> = (item: T, ctx: PoolTaskContext) => Promise<R>;

export interface RunPoolOptions<T, R> {
  items: T[];
  concurrency: number;
  task: PoolTask<T, R>;
  getTimeoutMs?: (item: T) => number;
  defaultTimeoutMs?: number;
  onTimeout?: (item: T, index: number) => R | Promise<R>;
  onError?: (item: T, index: number, error: unknown) => R | Promise<R>;
  onInFlightChange?: (currentInFlight: number) => void;
}

export async function runPool<T, R>(options: RunPoolOptions<T, R>): Promise<R[]> {
  const {
    items,
    concurrency,
    task,
    getTimeoutMs,
    defaultTimeoutMs = 30000,
    onTimeout,
    onError,
    onInFlightChange,
  } = options;

  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let currentInFlight = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;

      const item = items[idx]!;
      currentInFlight++;
      onInFlightChange?.(currentInFlight);

      const controller = new AbortController();
      const timeoutMs = getTimeoutMs ? getTimeoutMs(item) : defaultTimeoutMs;

      let timer: NodeJS.Timeout | undefined;
      let hasFinished = false;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (!hasFinished) {
            controller.abort();
            const err = new Error("timeout");
            (err as any).isTimeout = true;
            reject(err);
          }
        }, timeoutMs);
      });

      try {
        const res = await Promise.race([
          task(item, { signal: controller.signal, index: idx }),
          timeoutPromise,
        ]);
        hasFinished = true;
        results[idx] = res;
      } catch (err: unknown) {
        hasFinished = true;
        const isTimeout =
          (err instanceof Error && (err.message === "timeout" || (err as any).isTimeout)) ||
          controller.signal.aborted;

        if (isTimeout) {
          if (onTimeout) {
            results[idx] = await onTimeout(item, idx);
          } else {
            results[idx] = { error: "timeout" } as unknown as R;
          }
        } else {
          if (onError) {
            results[idx] = await onError(item, idx, err);
          } else {
            const errorMsg = err instanceof Error ? err.message : String(err);
            results[idx] = { error: errorMsg } as unknown as R;
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        currentInFlight--;
        onInFlightChange?.(currentInFlight);
      }
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}
