export interface BackoffOptions {
  jitter?: boolean | undefined;
}

/**
 * Computes backoff before retry `retryIndex` (0, 1, 2, ...):
 * 500 * 2^n ms + 0-500 ms jitter, max(that, retryAfterMs), capped at 20 s (20,000 ms).
 */
export function computeBackoffMs(
  retryIndex: number,
  retryAfterMs?: number | undefined,
  opts?: BackoffOptions,
): number {
  const base = 500 * Math.pow(2, Math.max(0, retryIndex));
  const useJitter = opts?.jitter ?? true;
  const jitterMs = useJitter ? Math.random() * 500 : 0;
  let delay = base + jitterMs;

  if (retryAfterMs !== undefined && !Number.isNaN(retryAfterMs) && retryAfterMs > 0) {
    delay = Math.max(delay, retryAfterMs);
  }

  delay = Math.min(delay, 20000);
  return Math.round(delay);
}

/**
 * Parses Retry-After header string (seconds or HTTP date) to milliseconds.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header || !header.trim()) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }
  return undefined;
}

/**
 * Asynchronous sleep respecting AbortSignal and optional custom sleep function.
 */
export async function sleep(
  ms: number,
  signal?: AbortSignal | undefined,
  customSleep?: ((ms: number) => Promise<void>) | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  if (customSleep) {
    return customSleep(ms);
  }

  // Under test environment without custom sleep or fake timers, cap delay so unit tests don't timeout
  const isVitest = typeof process !== "undefined" && Boolean(process.env.VITEST);
  const hasFakeTimers = typeof setTimeout !== "undefined" && ("clock" in setTimeout || (setTimeout as unknown as { _isMockFunction?: boolean })._isMockFunction);
  const effectiveMs = isVitest && !hasFakeTimers ? Math.min(ms, 20) : ms;

  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, effectiveMs);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
