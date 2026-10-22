// The budget fallback (#89): while the settings API says this month's budget
// is low, every `anthropic` request runs on the fallback model.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { budgetHeader } from "../auto-route";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { LlmClient, type RequestRecord } from "../llm";
import { Runtime, type BudgetState } from "../runtime";
import type { Context, Json, Message } from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config = (statePath = "") =>
  loadConfig({ ANTHROPIC_API_KEY: "fixture", CLAUDE_MAX_API_KEY: "fixture", RUNTIME_STATE_PATH: statePath });
const low: BudgetState = { low: true, remaining_after_today_usd: 8, checked_at: 1 };
const opus = { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" };

describe("Runtime.budgetSelection", () => {
  test("leaves every request alone until the API has said the budget is low", async () => {
    const runtime = new Runtime(config());
    expect(runtime.budgetSelection(opus)).toBe(opus);
    await runtime.setBudget({ ...low, low: false });
    expect(runtime.budgetSelection(opus)).toBe(opus);
  });

  test("while low, an Anthropic API request of any model, effort or route runs on the default fallback", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    const haikuHigh = { provider: "anthropic", model: "claude-haiku-5-5", effort: "high" };
    expect(runtime.budgetSelection(opus)).toEqual(haikuHigh);
    expect(runtime.budgetSelection({ provider: "anthropic", model: "auto" })).toEqual(haikuHigh);
    expect(runtime.budgetSelection({ provider: "anthropic", model: "claude-opus-5-5", effort: "high", routed: true })).toEqual(haikuHigh);
    expect(runtime.budgetSelection({ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" })).toEqual(haikuHigh);
  });

  test("other providers are not switched, Anthropic Workspace and Claude Max included", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    for (const selection of [
      { provider: "anthropic_workspace", model: "claude-opus-5-5" },
      { provider: "claude_max", model: "claude-opus-5-5" },
      { provider: "claude_kiro", model: "claude-sonnet-5" },
      { provider: "deepseek", model: "deepseek-flash" },
    ]) expect(runtime.budgetSelection(selection)).toBe(selection);
  });

  test("runs the model the dashboard chose, or the default when that one was hidden since", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    runtime.replace({ ...runtime.snapshot, budget_fallback: { preset: "anthropic-sonnet-5-5", effort: "medium" } }, false);
    expect(runtime.budgetSelection(opus)).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" });
    runtime.replace({ ...runtime.snapshot, unpublished_presets: ["anthropic-sonnet-5-5"] }, false);
    expect(runtime.budgetSelection(opus)).toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" });
    // A value the catalog no longer knows is the default too.
    runtime.replace({ ...runtime.snapshot, unpublished_presets: [], budget_fallback: { preset: "anthropic-gone", effort: "high" } as never }, false);
    expect(runtime.budgetSelection(opus)).toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" });
  });

  test("a snapshot from the API does not carry the budget, so it keeps the bot's last answer", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    runtime.replace({ version: 9, guilds: {}, user_contexts: {}, user_overrides: {}, blocked_users: [], user_roles: {}, unpublished_presets: [], premium_presets: [] });
    expect(runtime.budgetLow()).toBe(true);
  });

  test("the last decision survives a restart, and each change is reported once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hibana-budget-"));
    dirs.push(dir);
    const path = join(dir, "runtime_state.json");
    const first = new Runtime(config(path));
    const changes: boolean[] = [];
    first.onBudgetChange = (state) => changes.push(state.low);
    await first.setBudget(low);
    await first.setBudget({ ...low, checked_at: 2 });
    expect(changes).toEqual([true]);

    const second = new Runtime(config(path));
    await second.load();
    expect(second.budgetLow()).toBe(true);
    expect(second.budgetSelection(opus).model).toBe("claude-haiku-5-5");
  });
});

describe("LlmClient budget hook", () => {
  test("swaps the model and effort that are sent and recorded; other providers are sent as they were", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    const bodies: Json[] = [];
    const records: RequestRecord[] = [];
    const client = new LlmClient(config(), async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
    }, {
      budgetSelection: (s) => runtime.budgetSelection(s),
      onCompletion: (r) => records.push(r),
    });
    await client.complete(opus, [{ role: "user", content: "Hi" }], []);
    expect(bodies[0].model).toBe("claude-haiku-5-5");
    expect(bodies[0].output_config).toEqual({ effort: "high" });
    expect(records[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });

    // The auto preset is not a wire id; it is replaced before the swap.
    await client.complete({ provider: "anthropic", model: "auto" }, [{ role: "user", content: "Hi" }], []);
    expect(bodies[1].model).toBe("claude-haiku-5-5");

    await client.complete({ provider: "claude_max", model: "claude-opus-5-5", effort: "medium" }, [{ role: "user", content: "Hi" }], []);
    expect(bodies[2].model).toBe("claude-opus-5-5");
    expect(bodies[2].output_config).toEqual({ effort: "medium" });

    // Back above the threshold: the stored model again.
    await runtime.setBudget({ ...low, low: false });
    await client.complete(opus, [{ role: "user", content: "Hi" }], []);
    expect(bodies[3].model).toBe("claude-opus-5-5");
  });
});

test("the Discord notice names the threshold and the model", () => {
  expect(budgetHeader({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" }))
    .toBe("今月の利用料の残りが $10 を切ったため、**Haiku 5.5 High** で応答します");
  expect(budgetHeader({ provider: "anthropic", model: "claude-opus-5-5", effort: "max" }))
    .toBe("今月の利用料の残りが $10 を切ったため、**Opus 5.5 Max** で応答します");
  // The threshold an Administrator stored (#95).
  expect(budgetHeader({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" }, 25))
    .toBe("今月の利用料の残りが $25 を切ったため、**Haiku 5.5 High** で応答します");
  expect(budgetHeader({ provider: "anthropic", model: "claude-haiku-5-5", effort: "high" }, 7.5))
    .toBe("今月の利用料の残りが $7.50 を切ったため、**Haiku 5.5 High** で応答します");
});

test("a turn on the auto preset skips routing, says so once, and keeps its conversation for afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hibana-budget-turn-"));
  dirs.push(dir);
  const bot = new Hibana(loadConfig({
    HIBANA_DATA_DIR: dir, PROVIDER: "anthropic", LLM_MODEL: "auto", ANTHROPIC_API_KEY: "anthropic-fixture",
    JEV_API_KEY: "jev-fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", LOG_DIR: "",
  }), pino({ enabled: false }));
  const ctx: Context = { channelId: "10000", userId: "20000", botId: "30000", thread: false, depth: 0, delivered: false };
  bot.runtime.snapshot.user_roles[ctx.userId] = "premium";
  const sent: string[] = [];
  bot.client.channels.fetch = (async () => ({
    id: ctx.channelId, isSendable: () => true, sendTyping: async () => {},
    send: async (value: { content: string }) => { sent.push(value.content); return { id: "40000", edit: async () => {} }; },
  })) as never;
  bot.tools.tools = () => [];
  let routings = 0;
  bot.tools.jev.decide = (async (input: { questions: Json }) => {
    if (!input.questions.difficulty) throw new Error("not routing");
    routings++;
    return {
      model: "~typesafe/jev-latest",
      answers: { difficulty: { type: "score", score: 5 }, requested_model: { type: "choice", choice: "none" } },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0,
    };
  }) as never;
  const used: string[] = [];
  const seen: Message[][] = [];
  bot.llm.complete = async (selection, messages) => {
    used.push(`${selection.model}/${selection.effort}`);
    seen.push(structuredClone(messages));
    return { message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 }, incomplete: false };
  };
  const notices = () => sent.filter((text) => text.startsWith("今月の利用料"));
  await bot.runtime.setBudget(low);
  await bot.respond("難しい設計の相談", { ...ctx });
  await bot.respond("続けて", { ...ctx });
  expect(used).toEqual(["claude-haiku-5-5/high", "claude-haiku-5-5/high"]);
  // Jev is not asked for a route the request would not use.
  expect(routings).toBe(0);
  expect(notices()).toEqual(["今月の利用料の残りが $10 を切ったため、**Haiku 5.5 High** で応答します"]);
  expect(sent.some((text) => text.startsWith("Auto Routing"))).toBe(false);

  // The budget is back: the auto preset routes again, and the conversation
  // filed under it is the one the fallback turns added to.
  await bot.runtime.setBudget({ ...low, low: false });
  await bot.respond("Opus でまとめて", { ...ctx });
  expect(routings).toBe(1);
  expect(used.at(-1)).toBe("claude-opus-5-5/high");
  const history = JSON.stringify(seen.at(-1));
  expect(history).toContain("難しい設計の相談");
  expect(history).toContain("続けて");

  // A later fallback is announced again, with the threshold the API decided
  // with (#95).
  await bot.runtime.setBudget({ ...low, threshold_usd: 25 });
  await bot.respond("もう一度", { ...ctx });
  expect(notices()).toHaveLength(2);
  expect(notices().at(-1)).toBe("今月の利用料の残りが $25 を切ったため、**Haiku 5.5 High** で応答します");
});
