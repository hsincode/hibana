import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BUDGET_FALLBACK,
  DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD,
  budgetFallbackSelection,
  budgetLow,
  budgetThresholdSchema,
  formatThreshold,
  isBudgetFallbackPreset,
  parseBudgetFallback,
  parseBudgetThreshold,
} from "../budget";

describe("budget fallback (#89)", () => {
  test("the owner's threshold and default: below $10, Anthropic API Haiku 5.5 High", () => {
    expect(DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD).toBe(10);
    expect(budgetLow(9.99, 10)).toBe(true);
    expect(budgetLow(10, 10)).toBe(false);
    expect(budgetLow(-5, 10)).toBe(true);
    expect(budgetFallbackSelection(DEFAULT_BUDGET_FALLBACK)).toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" });
  });

  test("only Anthropic API presets other than Auto may be the fallback", () => {
    expect(isBudgetFallbackPreset("anthropic-haiku-5-5")).toBe(true);
    expect(isBudgetFallbackPreset("anthropic-opus-5-5")).toBe(true);
    expect(isBudgetFallbackPreset("anthropic-auto")).toBe(false);
    expect(isBudgetFallbackPreset("anthropic-workspace-haiku-5-5")).toBe(false);
    expect(isBudgetFallbackPreset("max-opus-5-5")).toBe(false);
    expect(isBudgetFallbackPreset("sonnet-5")).toBe(false);
    expect(isBudgetFallbackPreset("nope")).toBe(false);
  });

  test("a stored value that no longer parses reads as the default", () => {
    expect(parseBudgetFallback(null)).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(parseBudgetFallback("not json")).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(parseBudgetFallback('{"preset":"anthropic-gone","effort":"high"}')).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(parseBudgetFallback({ preset: "anthropic-opus-5-5", effort: "none" })).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(parseBudgetFallback('{"preset":"anthropic-sonnet-5-5","effort":"medium"}')).toEqual({ preset: "anthropic-sonnet-5-5", effort: "medium" });
    // The default is a copy: a caller changing it does not change the next read.
    const read = parseBudgetFallback(null);
    read.effort = "low";
    expect(parseBudgetFallback(null).effort).toBe("high");
  });

  test("the threshold an Administrator stores is checked against the stored one (#95)", () => {
    expect(budgetLow(24.99, 25)).toBe(true);
    expect(budgetLow(25, 25)).toBe(false);
    // $0: only an exceeded budget switches.
    expect(budgetLow(0, 0)).toBe(false);
    expect(budgetLow(-0.01, 0)).toBe(true);
  });
});

describe("budget threshold (#95)", () => {
  const schema = budgetThresholdSchema(200);

  test("whole cents from $0 to the monthly budget", () => {
    for (const ok of [0, 0.01, 10, 12.5, 199.99, 200]) expect(schema.parse(ok)).toBe(ok);
    // Floating point noise from a form is rounded to the cent it names.
    expect(schema.parse(0.1 + 0.2)).toBe(0.3);
    expect(schema.parse(19.99)).toBe(19.99);
    for (const bad of [-0.01, 200.01, 1.005, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined])
      expect(schema.safeParse(bad).success).toBe(false);
  });

  test("a stored threshold that no longer parses reads as the default", () => {
    expect(parseBudgetThreshold(null, 200)).toBe(10);
    expect(parseBudgetThreshold("not json", 200)).toBe(10);
    expect(parseBudgetThreshold("25", 200)).toBe(25);
    expect(parseBudgetThreshold("7.5", 200)).toBe(7.5);
    expect(parseBudgetThreshold(25, 200)).toBe(25);
    // The monthly budget was lowered below the stored value.
    expect(parseBudgetThreshold("150", 100)).toBe(10);
    expect(parseBudgetThreshold("-1", 200)).toBe(10);
  });

  test("the notice writes whole dollars without cents", () => {
    expect(formatThreshold(10)).toBe("$10");
    expect(formatThreshold(7.5)).toBe("$7.50");
    expect(formatThreshold(0)).toBe("$0");
  });
});
