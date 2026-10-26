import { expect, test } from "bun:test";
import { MODEL_PRESETS, compactionThreshold, contextWindow } from "../catalog";

test("a preset's context window is read by provider and model (#124)", () => {
  const known = MODEL_PRESETS.filter(
    (p): p is (typeof MODEL_PRESETS)[number] & { context_window: number } =>
      "context_window" in p && typeof p.context_window === "number",
  );
  expect(known.length).toBeGreaterThan(0);
  for (const p of known) {
    expect(Number.isInteger(p.context_window)).toBe(true);
    expect(p.context_window).toBeGreaterThan(0);
    expect(contextWindow({ provider: p.provider, model: p.model })).toBe(
      p.context_window,
    );
  }
  // Custom endpoints, Auto Routing and models outside the catalog have none.
  expect(contextWindow({ provider: "custom", model: "gpt-test" })).toBe(
    undefined,
  );
  expect(contextWindow({ provider: "anthropic", model: "auto" })).toBe(
    undefined,
  );
  expect(contextWindow(undefined)).toBe(undefined);
});

test("the summary starts at a share of the window, or at the fallback when the window is unknown (#124)", () => {
  const p = MODEL_PRESETS.find(
    (x): x is (typeof MODEL_PRESETS)[number] & { context_window: number } =>
      "context_window" in x && typeof x.context_window === "number",
  )!;
  const selection = { provider: p.provider, model: p.model };
  expect(compactionThreshold(selection, 90, 100_000)).toBe(
    Math.floor((p.context_window * 90) / 100),
  );
  expect(compactionThreshold(selection, 100, 100_000)).toBe(p.context_window);
  expect(
    compactionThreshold({ provider: "custom", model: "x" }, 90, 100_000),
  ).toBe(100_000);
  // The percentage does not scale the fallback: it is already a token count.
  expect(
    compactionThreshold({ provider: "custom", model: "x" }, 50, 100_000),
  ).toBe(100_000);
});
