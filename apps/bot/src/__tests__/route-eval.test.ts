import { expect, test } from "bun:test";
import { AUTO_ROUTE_LEVELS } from "@hibana/shared/catalog";
import { evaluateRoute, namesModel } from "../auto-route";
import { ROUTE_CASES } from "../route-eval";
import type { Message } from "../types";

// The cases run against the real Jev only by hand (`bun run route-eval`).
// These checks keep the set usable without the API.
test("the routing cases cover every model, Opus included, and both kinds of model mention", () => {
  const byDifficulty = ROUTE_CASES.filter((c) => !c.requested && c.tiers.length < 3);
  for (const tier of ["haiku", "sonnet", "opus"] as const) {
    expect(byDifficulty.filter((c) => c.tiers.length === 1 && c.tiers[0] === tier).length).toBeGreaterThanOrEqual(10);
    expect(ROUTE_CASES.filter((c) => c.requested === tier).length).toBeGreaterThanOrEqual(3);
  }
  expect(ROUTE_CASES.filter((c) => !c.requested && c.tiers.length === 3).length).toBeGreaterThanOrEqual(8);
  expect(new Set(ROUTE_CASES.map((c) => c.text)).size).toBe(ROUTE_CASES.length);
});

test("every request for a model passes the gate that asks Jev while a route is kept", () => {
  for (const c of ROUTE_CASES.filter((c) => c.requested)) expect([c.text, namesModel(c.text)]).toEqual([c.text, true]);
});

test("a top difficulty score reaches Opus, and nothing below the top level does", async () => {
  const request: Message[] = [{ role: "user", content: "証明して", turnStart: true }];
  const decide = (score: number) => async () => ({
    model: "~typesafe/jev-latest",
    answers: {
      difficulty: { type: "score" as const, score },
      requested_model: { type: "choice" as const, choice: "none" },
    },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
    cost: 0,
  });
  const top = AUTO_ROUTE_LEVELS.length - 1;
  const model = async (score: number) =>
    (await evaluateRoute(request, decide(score), new AbortController().signal)).selection.model;
  for (const score of [top - 0.49, top]) expect(await model(score)).toBe("claude-opus-5-5");
  for (const score of [0, 2, top - 0.51]) expect(await model(score)).not.toBe("claude-opus-5-5");
});
