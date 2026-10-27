import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

export interface PriceRow {
  in: number;
  cached?: number | undefined;
  out: number;
}

export interface CostResult {
  costUsd: number | null;
  priceMissing: boolean;
}

const DEFAULT_PRICES_PATH = fileURLToPath(new URL("../prices.yaml", import.meta.url));

let cachedPrices: Record<string, PriceRow> | null = null;

export function loadPrices(filePath: string = DEFAULT_PRICES_PATH): Record<string, PriceRow> {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.parse(content) as Record<string, unknown>;
  const table: Record<string, PriceRow> = {};

  for (const [key, val] of Object.entries(parsed)) {
    if (key === "as_of" || typeof val !== "object" || val === null) {
      continue;
    }
    const entry = val as { in?: unknown; cached?: unknown; out?: unknown };
    if (typeof entry.in === "number" && typeof entry.out === "number") {
      table[key] = {
        in: entry.in,
        out: entry.out,
        ...(typeof entry.cached === "number" ? { cached: entry.cached } : {}),
      };
    }
  }

  return table;
}

export function getPriceTable(): Record<string, PriceRow> {
  if (!cachedPrices) {
    cachedPrices = loadPrices();
  }
  return cachedPrices;
}

export function setPriceTable(table: Record<string, PriceRow> | null): void {
  cachedPrices = table;
}

export function getPrice(
  model: string,
  table: Record<string, PriceRow> = getPriceTable(),
): PriceRow | undefined {
  if (table[model]) {
    return table[model];
  }
  // Try matching without or with provider prefix
  const colonIdx = model.indexOf(":");
  if (colonIdx !== -1) {
    const withoutPrefix = model.slice(colonIdx + 1);
    for (const [key, val] of Object.entries(table)) {
      if (key.slice(key.indexOf(":") + 1) === withoutPrefix) {
        return val;
      }
    }
  }
  return undefined;
}

export function calculateCost(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
  tokensCached: number | null = 0,
  table: Record<string, PriceRow> = getPriceTable(),
): CostResult {
  if (model.startsWith("agy-cli") || tokensIn === null || tokensOut === null) {
    return { costUsd: null, priceMissing: false };
  }

  const price = getPrice(model, table);
  if (!price) {
    return { costUsd: 0, priceMissing: true };
  }

  const inTokens = Math.max(0, tokensIn);
  const outTokens = Math.max(0, tokensOut);
  const cached = Math.max(0, Math.min(inTokens, tokensCached ?? 0));
  const uncachedIn = inTokens - cached;
  const cachedPrice = price.cached ?? price.in;

  const cost = (uncachedIn * price.in + cached * cachedPrice + outTokens * price.out) / 1_000_000;

  return { costUsd: cost, priceMissing: false };
}
