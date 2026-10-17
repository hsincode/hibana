import { describe, expect, test } from "bun:test";
import {
  BUDGET_FALLBACK_THRESHOLD_USD,
  DEFAULT_BUDGET_FALLBACK,
  budgetFallbackSelection,
  budgetLow,
  isBudgetFallbackPreset,
  parseBudgetFallback,
} from "../budget";

describe("budget fallback (#89)", () => {
  test("the owner's threshold and default: below $10, Anthropic API Haiku 5.5 High", () => {
    expect(BUDGET_FALLBACK_THRESHOLD_USD).toBe(10);
    expect(budgetLow(9.99)).toBe(true);
    expect(budgetLow(10)).toBe(false);
    expect(budgetLow(-5)).toBe(true);
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
});
