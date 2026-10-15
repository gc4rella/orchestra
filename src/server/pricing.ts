import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { TokenBreakdown } from "../shared/types.ts";

/** Dollars per million tokens. Cached input is input the provider served from its prompt cache. */
export type Price = { input: number; cachedInput: number; output: number };

/**
 * Codex reports tokens but no cost, so Orchestra estimates it. These are list prices from third-party price
 * listings as of 2026-10, not confirmed against OpenAI's own page; `$ORCHESTRA_HOME/prices.json` overrides them
 * (`{"model-id": {"input": 1.25, "cachedInput": 0.125, "output": 10}}`). A model missing from both has no estimate.
 */
export const PRICES: Record<string, Price> = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
};

const Rate = z.number().min(0).max(10_000);
const PricesFile = z.record(z.string().min(1).max(100), z.strictObject({ input: Rate, cachedInput: Rate, output: Rate }));

/** The price for `model`, preferring the user's override file; null when unknown or the file is invalid. */
export function priceFor(model: string | null, home: string): Price | null {
  if (!model) return null;
  const file = join(home, "prices.json");
  if (existsSync(file)) {
    try {
      const overrides = PricesFile.parse(JSON.parse(readFileSync(file, "utf8")));
      if (overrides[model]) return overrides[model];
    } catch {
      return null;
    }
  }
  return PRICES[model] ?? null;
}

export const estimateCost = (tokens: TokenBreakdown, price: Price) =>
  (tokens.input * price.input + tokens.cached * price.cachedInput + tokens.output * price.output) / 1_000_000;
