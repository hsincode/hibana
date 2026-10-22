// The model Anthropic API turns switch to while the month's budget is nearly
// spent (decision record: #89), and the threshold that counts as nearly spent
// (#95). The settings API decides whether it is (`/internal/budget`, from the
// cost report and today's estimate); the bot asks and swaps the model of every
// `anthropic` request; the dashboard shows both and an Administrator edits them.

import { z } from "zod";
import {
  AUTO_ROUTE_MODEL,
  MODEL_PRESETS,
  SELECTABLE_PRESETS,
  canonicalPresetId,
} from "./catalog";

/** Turns switch once this month's remaining budget, today's estimate taken
 *  off, is below the threshold. This is the owner's value (#89), used until
 *  an Administrator stores another on the dashboard (#95). */
export const DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD = 10;

/** The only provider whose turns are switched (#89): the one billed against
 *  the budget the cost report shows. Anthropic Workspace has its own limits
 *  (#76). */
export const BUDGET_FALLBACK_PROVIDER = "anthropic";

/** Efforts the fallback may run at. `none` is left out: Claude 5.x cannot
 *  switch thinking off (the bot sends low instead), so it would only mislead. */
export const BUDGET_FALLBACK_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Presets the fallback may be: Anthropic API models, not the auto route.
 * A conversation keeps its provider's own blocks (Anthropic thinking blocks),
 * so the history of an `anthropic` turn can be continued by another
 * `anthropic` model but not sent to another provider's protocol.
 */
export function isBudgetFallbackPreset(raw: string): boolean {
  const id = canonicalPresetId(raw);
  return SELECTABLE_PRESETS.some(
    (p) =>
      p.id === id &&
      p.provider === BUDGET_FALLBACK_PROVIDER &&
      p.model !== AUTO_ROUTE_MODEL,
  );
}

export const budgetFallbackSchema = z
  .object({
    preset: z
      .string()
      .refine(isBudgetFallbackPreset, {
        message: "fallback must be an Anthropic API preset other than Auto",
      })
      .transform(canonicalPresetId),
    effort: z.enum(BUDGET_FALLBACK_EFFORTS),
  })
  .strict();
export type BudgetFallback = z.infer<typeof budgetFallbackSchema>;

/** The owner's default (#89): Anthropic API, Claude Haiku 5.5, effort high. */
export const DEFAULT_BUDGET_FALLBACK: BudgetFallback = {
  preset: "anthropic-haiku-5-5",
  effort: "high",
};

/** A stored value, or the default when there is none or it no longer parses
 *  (a preset removed from the catalog). */
export function parseBudgetFallback(raw: unknown): BudgetFallback {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_BUDGET_FALLBACK };
    }
  }
  const parsed = budgetFallbackSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_BUDGET_FALLBACK };
}

/** The selection a fallback runs as. */
export function budgetFallbackSelection(fallback: BudgetFallback): {
  provider: string;
  model: string;
  effort: string;
} {
  const preset = MODEL_PRESETS.find((p) => p.id === fallback.preset)!;
  return {
    provider: preset.provider,
    model: preset.model,
    effort: fallback.effort,
  };
}

/**
 * A threshold an Administrator may store (#95): whole cents from $0 to
 * `maxUsd`, the monthly budget. Above the budget every turn would switch from
 * the first day; at $0 turns switch only once the budget is exceeded. The
 * value is rounded to the cent it names, so 0.1 + 0.2 is stored as 0.3.
 */
export function budgetThresholdSchema(maxUsd: number) {
  return z
    .number()
    .finite()
    .min(0, { message: "threshold must not be negative" })
    .max(maxUsd, { message: `threshold must be at most ${maxUsd}` })
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: "threshold must be in whole cents",
    })
    .transform((v) => Math.round(v * 100) / 100);
}

/** A stored threshold, or the default when there is none or it no longer
 *  parses (the monthly budget was lowered below it). */
export function parseBudgetThreshold(raw: unknown, maxUsd: number): number {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD;
    }
  }
  const parsed = budgetThresholdSchema(maxUsd).safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD;
}

/** Whether a remaining amount, today's estimate already taken off, switches turns. */
export function budgetLow(
  remainingAfterTodayUsd: number,
  thresholdUsd: number,
): boolean {
  return remainingAfterTodayUsd < thresholdUsd;
}

/** "$10" or "$7.50": a threshold as the Discord notice writes it. */
export function formatThreshold(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}
