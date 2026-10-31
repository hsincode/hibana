// The budget fallback (#89, #121): once the settings API says this month's
// budget is low, it switches the stored settings to the fallback (tested in
// apps/api). The bot runs turns on what is stored, and says so once per
// channel on a turn still on what the switch wrote.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { budgetHeader } from "../auto-route";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { Runtime, type BudgetState } from "../runtime";
import type { Context, Json, Message } from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const config = (statePath = "") =>
  loadConfig({
    ANTHROPIC_API_KEY: "fixture",
    CLAUDE_MAX_API_KEY: "fixture",
    RUNTIME_STATE_PATH: statePath,
  });
const low: BudgetState = {
  low: true,
  remaining_after_today_usd: 8,
  checked_at: 1,
};
const opus = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "medium",
};

describe("Runtime.onBudgetFallback (#121)", () => {
  const haikuHigh = {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    effort: "high",
  };
  test("false until the API has said the budget is low", async () => {
    const runtime = new Runtime(config());
    expect(runtime.onBudgetFallback(haikuHigh)).toBe(false);
    await runtime.setBudget({ ...low, low: false });
    expect(runtime.onBudgetFallback(haikuHigh)).toBe(false);
  });

  test("while low, true only for what the switch writes: the fallback, or its model on Workspace", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    expect(runtime.onBudgetFallback(haikuHigh)).toBe(true);
    expect(
      runtime.onBudgetFallback({
        ...haikuHigh,
        provider: "anthropic_workspace",
      }),
    ).toBe(true);
    // Picked after the switch: no notice, it runs as picked.
    for (const selection of [
      { ...haikuHigh, effort: "xhigh" },
      opus,
      { provider: "anthropic", model: "auto" },
      { provider: "claude_max", model: "claude-haiku-5-5", effort: "high" },
    ])
      expect(runtime.onBudgetFallback(selection)).toBe(false);
  });

  test("names the model the dashboard chose, or the default when that one was hidden since", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    runtime.replace(
      {
        ...runtime.snapshot,
        budget_fallback: { preset: "anthropic-sonnet-5-5", effort: "medium" },
      },
      false,
    );
    const sonnet = {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      effort: "medium",
    };
    expect(runtime.budgetFallback()).toEqual(sonnet);
    expect(runtime.onBudgetFallback(sonnet)).toBe(true);
    expect(runtime.onBudgetFallback(haikuHigh)).toBe(false);
    runtime.replace(
      { ...runtime.snapshot, unpublished_presets: ["anthropic-sonnet-5-5"] },
      false,
    );
    expect(runtime.budgetFallback()).toEqual(haikuHigh);
    // A value the catalog no longer knows is the default too.
    runtime.replace(
      {
        ...runtime.snapshot,
        unpublished_presets: [],
        budget_fallback: { preset: "anthropic-gone", effort: "high" } as never,
      },
      false,
    );
    expect(runtime.budgetFallback()).toEqual(haikuHigh);
  });

  test("a fallback of another provider (#146) is told on that provider only, not on Workspace", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    runtime.replace(
      {
        ...runtime.snapshot,
        budget_fallback: { preset: "max-opus-5-5", effort: "high" },
      },
      false,
    );
    const maxOpus = {
      provider: "claude_max",
      model: "claude-opus-5-5",
      effort: "high",
    };
    expect(runtime.budgetFallback()).toEqual(maxOpus);
    expect(runtime.onBudgetFallback(maxOpus)).toBe(true);
    // Same model name, but the switch never writes these for this fallback.
    for (const provider of ["anthropic", "anthropic_workspace"])
      expect(runtime.onBudgetFallback({ ...maxOpus, provider })).toBe(false);
  });

  test("a snapshot from the API does not carry the budget, so it keeps the bot's last answer", async () => {
    const runtime = new Runtime(config());
    await runtime.setBudget(low);
    runtime.replace({
      version: 9,
      guilds: {},
      user_contexts: {},
      user_overrides: {},
      blocked_users: [],
      user_roles: {},
      unpublished_presets: [],
      premium_presets: [],
    });
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
  });
});

test("while low, LlmClient sends the model and effort it is given (#121)", async () => {
  const bodies: Json[] = [];
  const client = new LlmClient(config(), async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
  await client.complete(
    { provider: "anthropic", model: "claude-haiku-5-5", effort: "xhigh" },
    [{ role: "user", content: "Hi" }],
    [],
  );
  expect(bodies[0].model).toBe("claude-haiku-5-5");
  expect(bodies[0].output_config).toEqual({ effort: "xhigh" });
});

test("the Discord notice names the threshold and the model", () => {
  expect(
    budgetHeader({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "high",
    }),
  ).toBe(
    "今月の利用料の残りが $10 を切ったため、Anthropic のモデルを **Haiku 5.5 High** に切り替えました。設定から変更できます",
  );
  expect(
    budgetHeader({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "max",
    }),
  ).toBe(
    "今月の利用料の残りが $10 を切ったため、Anthropic のモデルを **Opus 5.5 Max** に切り替えました。設定から変更できます",
  );
  // The threshold an Administrator stored (#95).
  expect(
    budgetHeader(
      { provider: "anthropic", model: "claude-haiku-5-5", effort: "high" },
      25,
    ),
  ).toBe(
    "今月の利用料の残りが $25 を切ったため、Anthropic のモデルを **Haiku 5.5 High** に切り替えました。設定から変更できます",
  );
  expect(
    budgetHeader(
      { provider: "anthropic", model: "claude-haiku-5-5", effort: "high" },
      7.5,
    ),
  ).toBe(
    "今月の利用料の残りが $7.50 を切ったため、Anthropic のモデルを **Haiku 5.5 High** に切り替えました。設定から変更できます",
  );
});

function turnBot(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hibana-budget-turn-"));
  dirs.push(dir);
  const bot = new Hibana(
    loadConfig({
      HIBANA_DATA_DIR: dir,
      PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "anthropic-fixture",
      JEV_API_KEY: "jev-fixture",
      SANDBOX_ENABLED: "false",
      SKILLS_ENABLED: "false",
      LOG_DIR: "",
      ...env,
    }),
    pino({ enabled: false }),
  );
  const ctx: Context = {
    channelId: "10000",
    userId: "20000",
    botId: "30000",
    thread: false,
    depth: 0,
    delivered: false,
  };
  bot.runtime.snapshot.user_roles[ctx.userId] = "premium";
  const sent: string[] = [];
  bot.client.channels.fetch = (async () => ({
    id: ctx.channelId,
    isSendable: () => true,
    sendTyping: async () => {},
    send: async (value: { content: string }) => {
      sent.push(value.content);
      return { id: "40000", edit: async () => {} };
    },
  })) as never;
  bot.tools.tools = () => [];
  let routings = 0;
  bot.tools.jev.decide = (async (input: { questions: Json }) => {
    if (!input.questions.difficulty) throw new Error("not routing");
    routings++;
    return {
      model: "~typesafe/jev-latest",
      answers: {
        difficulty: { type: "score", score: 5 },
        requested_model: { type: "choice", choice: "none" },
      },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0,
    };
  }) as never;
  const used: string[] = [];
  const seen: Message[][] = [];
  bot.llm.complete = async (selection, messages) => {
    used.push(`${selection.model}/${selection.effort}`);
    seen.push(structuredClone(messages));
    return {
      message: { role: "assistant", content: "ok" },
      usage: {
        prompt_tokens: 4,
        completion_tokens: 1,
        total_tokens: 5,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      incomplete: false,
    };
  };
  const notices = () => sent.filter((text) => text.startsWith("今月の利用料"));
  return { bot, ctx, sent, used, seen, notices, routings: () => routings };
}

test("while low, a model picked after the switch runs as picked, without a notice", async () => {
  const t = turnBot({ LLM_MODEL: "claude-haiku-5-5", LLM_EFFORT: "xhigh" });
  await t.bot.runtime.setBudget(low);
  await t.bot.respond("こんにちは", { ...t.ctx });
  expect(t.used).toEqual(["claude-haiku-5-5/xhigh"]);
  expect(t.notices()).toEqual([]);
});

test("while low, the auto preset picked again routes as usual", async () => {
  const t = turnBot({ LLM_MODEL: "auto" });
  await t.bot.runtime.setBudget(low);
  await t.bot.respond("難しい設計の相談", { ...t.ctx });
  expect(t.routings()).toBe(1);
  expect(t.used).toEqual(["claude-opus-5-5/high"]);
  expect(t.notices()).toEqual([]);
});

test("a turn on what the switch wrote says so once per channel, and again after the next switch", async () => {
  const t = turnBot({ LLM_MODEL: "claude-haiku-5-5", LLM_EFFORT: "high" });
  await t.bot.runtime.setBudget(low);
  await t.bot.respond("難しい設計の相談", { ...t.ctx });
  await t.bot.respond("続けて", { ...t.ctx });
  expect(t.used).toEqual(["claude-haiku-5-5/high", "claude-haiku-5-5/high"]);
  expect(t.notices()).toEqual([
    "今月の利用料の残りが $10 を切ったため、Anthropic のモデルを **Haiku 5.5 High** に切り替えました。設定から変更できます",
  ]);
  // The same conversation continues: the notice is not in the history.
  expect(JSON.stringify(t.seen.at(-1))).toContain("難しい設計の相談");
  expect(JSON.stringify(t.seen.at(-1))).not.toContain("今月の利用料");

  // The budget is back, then low again, with the threshold the API decided
  // with (#95): announced again.
  await t.bot.runtime.setBudget({ ...low, low: false });
  await t.bot.respond("まだ続く", { ...t.ctx });
  expect(t.notices()).toHaveLength(1);
  await t.bot.runtime.setBudget({ ...low, threshold_usd: 25 });
  await t.bot.respond("もう一度", { ...t.ctx });
  expect(t.notices()).toHaveLength(2);
  expect(t.notices().at(-1)).toBe(
    "今月の利用料の残りが $25 を切ったため、Anthropic のモデルを **Haiku 5.5 High** に切り替えました。設定から変更できます",
  );
});
