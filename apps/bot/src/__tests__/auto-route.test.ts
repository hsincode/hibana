import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "discord.js";
import pino from "pino";
import { AUTO_ROUTE_FALLBACK, AUTO_ROUTE_LEVELS, MODEL_PRESETS } from "@hibana/shared/catalog";
import { Agent } from "../agent";
import {
  ROUTE_CACHE_TTL_MS,
  RouteMemory,
  concreteSelection,
  evaluateRoute,
  namesModel,
  routeHeader,
  routeFallback,
  routeInput,
} from "../auto-route";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { assertChildSelection, selectChild } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import type { Context, Json, Message } from "../types";

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    CODEX_PLUS_API_KEY: "plus-fixture",
    ANTHROPIC_API_KEY: "anthropic-fixture",
    JEV_API_KEY: "jev-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    ...env,
  });
const context = (): Context => ({
  guildId: "g1", channelId: "c1", userId: "member", botId: "bot", thread: false, depth: 0, delivered: false,
});
const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 };
const scored = (score: number, requested = "none") => async () => ({
  model: "~typesafe/jev-latest",
  answers: {
    difficulty: { type: "score" as const, score },
    requested_model: { type: "choice" as const, choice: requested },
  },
  usage,
  cost: 0,
});
const request: Message[] = [{ role: "user", content: "この関数のバグを直して", turnStart: true }];
const never = new AbortController().signal;

test("the routing table is the owner's five levels and never uses max", () => {
  expect(AUTO_ROUTE_LEVELS.map((l) => `${l.model}/${l.effort}`)).toEqual([
    "claude-haiku-5-5/medium", "claude-haiku-5-5/high",
    "claude-sonnet-5-5/medium", "claude-sonnet-5-5/high",
    "claude-opus-5-5/medium",
  ]);
  for (const level of [...AUTO_ROUTE_LEVELS, AUTO_ROUTE_FALLBACK])
    expect(["low", "medium", "high", "xhigh"]).toContain(level.effort);
  expect(AUTO_ROUTE_FALLBACK).toEqual({ model: "claude-haiku-5-5", effort: "high" });
  expect(MODEL_PRESETS.filter((p) => p.provider === "anthropic").map((p) => p.model)).toEqual([
    "auto", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5",
  ]);
});

test("Jev's difficulty score picks the nearest level", async () => {
  const input = routeInput(request);
  expect(input.questions.difficulty.criteria).toHaveLength(AUTO_ROUTE_LEVELS.length);
  expect(input.state.latest_user_request).toBe("この関数のバグを直して");
  expect(JSON.stringify(input.questions.difficulty)).not.toMatch(/haiku|sonnet|opus/i);
  for (const [score, model, effort] of [
    [0, "claude-haiku-5-5", "medium"], [1.4, "claude-haiku-5-5", "high"],
    [1.6, "claude-sonnet-5-5", "medium"], [3, "claude-sonnet-5-5", "high"],
    [4, "claude-opus-5-5", "medium"], [5, "claude-opus-5-5", "medium"],
  ] as const)
    expect((await evaluateRoute(request, scored(score), never)).selection)
      .toEqual({ provider: "anthropic", model, effort, routed: true });
  await expect(evaluateRoute(request, async () => ({
    model: "x", answers: { difficulty: { type: "noul" as const, noul: 1 } }, usage, cost: 0,
  }), never)).rejects.toThrow("Invalid Jev route decision");
  await expect(evaluateRoute(request, async () => ({
    model: "x", answers: { difficulty: { type: "score" as const, score: 1 } }, usage, cost: 0,
  }), never)).rejects.toThrow("Invalid Jev route decision");
});

test("a model the user asks for wins, at its level nearest to the difficulty", async () => {
  for (const [score, requested, model, effort] of [
    [0, "opus", "claude-opus-5-5", "medium"], [5, "haiku", "claude-haiku-5-5", "high"],
    [0, "sonnet", "claude-sonnet-5-5", "medium"], [3, "sonnet", "claude-sonnet-5-5", "high"],
    [5, "sonnet", "claude-sonnet-5-5", "high"], [0, "haiku", "claude-haiku-5-5", "medium"],
  ] as const) {
    const decided = await evaluateRoute(request, scored(score, requested), never);
    expect(decided.requested).toBe(requested);
    expect(decided.selection).toEqual({ provider: "anthropic", model, effort, routed: true });
  }
  expect((await evaluateRoute(request, scored(5), never)).requested).toBeUndefined();
  expect(namesModel("Opusで答えて")).toBe(true);
  expect(namesModel("ソネットにして")).toBe(true);
  expect(namesModel("ありがとう")).toBe(false);
  await expect(evaluateRoute([], scored(1), never)).rejects.toThrow("No user request");
});

test("a route is kept until the cache TTL passes since its last use", () => {
  let now = 1000;
  const memory = new RouteMemory(() => now);
  const route = routeFallback();
  expect(memory.live("c1")).toBeUndefined();
  memory.set("c1", route);
  now += ROUTE_CACHE_TTL_MS - 1;
  expect(memory.live("c1")).toEqual(route);
  // A request inside the window renews the cache, and so the route.
  memory.touch("c1");
  now += ROUTE_CACHE_TTL_MS - 1;
  expect(memory.live("c1")).toEqual(route);
  now += 1;
  expect(memory.live("c1")).toBeUndefined();
  memory.set("c1", route);
  memory.clear("c1");
  expect(memory.live("c1")).toBeUndefined();
});

async function routeWith(env: NodeJS.ProcessEnv, decide: ToolRegistry["jev"]["decide"], settings: Json = {}) {
  const runtime = new Runtime(config(env));
  runtime.snapshot.user_roles.owner = "premium";
  await runtime.patch("g1", { preset: "anthropic-auto", ...settings }, "owner");
  const client = new Client({ intents: [] });
  const records: Json[] = [];
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)),
    pino({ level: "info" }, { write: (line) => { records.push(JSON.parse(line)); } }));
  registry.jev.decide = decide;
  try {
    const result = await registry.route(context(), request);
    return { result, log: records.find((r) => r.msg === "Jev route finished")! };
  } finally { await registry.close(); client.destroy(); }
}

test("routing asks Jev once and reports nothing when Jev is unavailable", async () => {
  let calls = 0;
  const decide: ToolRegistry["jev"]["decide"] = async () => { calls++; return scored(3)(); };
  const routed = await routeWith({}, decide);
  expect(routed.result?.selection).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", routed: true });
  expect(routed.result?.usage).toEqual(usage);
  expect(routed.log).toMatchObject({ verdict: "classified", level: 3, model: "claude-sonnet-5-5", effort: "high" });
  expect(JSON.stringify(routed.log)).not.toContain("バグ");
  expect(calls).toBe(1);

  expect((await routeWith({ JEV_API_KEY: "" }, decide)).result).toBeUndefined();
  const off = await routeWith({}, decide, { jev_enabled: false });
  expect(off.result).toBeUndefined();
  expect(off.log.verdict).toBe("disabled");
  expect(calls).toBe(1);
  const failed = await routeWith({}, async () => { throw new Error("Jev: HTTP 503"); });
  expect(failed.result).toBeUndefined();
  expect(failed.log.verdict).toBe("unavailable");
});

test("Anthropic requests use the Messages API with the API key header only", async () => {
  const cfg = config();
  const seen: { url: string; headers: Record<string, string>; body: Json }[] = [];
  const client = new LlmClient(cfg, async (url, init) => {
    seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  });
  const ask: Message[] = [{ role: "user", content: "Hello" }];
  await client.complete({ provider: "anthropic", model: "claude-haiku-5-5", effort: "xhigh" }, ask, []);
  expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(seen[0]!.headers["x-api-key"]).toBe("anthropic-fixture");
  expect(seen[0]!.headers.Authorization).toBeUndefined();
  expect(seen[0]!.body).toMatchObject({
    model: "claude-haiku-5-5", thinking: { type: "adaptive" }, output_config: { effort: "xhigh" },
  });
  // Outside auto routing the stored effort is sent as chosen.
  await client.complete({ provider: "anthropic", model: "claude-opus-5-5", effort: "max" }, ask, []);
  expect(seen[1]!.body.output_config).toEqual({ effort: "max" });
});

test("a routed selection never sends max, and the auto preset never reaches the wire", async () => {
  const bodies: Json[] = [];
  const client = new LlmClient(config(), async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  });
  const ask: Message[] = [{ role: "user", content: "Hello" }];
  // e.g. a child that inherited the route under a fixed max subagent effort.
  await client.complete({ provider: "anthropic", model: "claude-opus-5-5", effort: "max", routed: true }, ask, []);
  expect(bodies[0]!.output_config).toEqual({ effort: "xhigh" });
  await client.complete({ provider: "anthropic", model: "auto", effort: "max" }, ask, []);
  expect(bodies[1]).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "high" } });
  expect(routeHeader({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "xhigh", routed: true }))
    .toBe("Auto Routing: **Sonnet 5.5 XHigh**");
  expect(concreteSelection({ provider: "codex_plus", model: "gpt-6-luna" })).toEqual({ provider: "codex_plus", model: "gpt-6-luna" });
});

test("a Premium user sets the server's Anthropic model and every member uses it", async () => {
  const runtime = new Runtime(config());
  runtime.snapshot.user_roles.owner = "premium";
  expect(runtime.canSelect("anthropic-auto", "member")).toBe(false);
  await expect(runtime.patch("g1", { preset: "anthropic-auto" }, "member")).rejects.toThrow("unavailable");
  await runtime.patch("g1", { preset: "anthropic-auto" }, "owner");
  expect(runtime.resolve("g1", "member").selection).toMatchObject({ provider: "anthropic", model: "auto" });
  // The server's auto pick covers the models it routes to, for children too.
  const ctx = context();
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
    expect(() => assertChildSelection(runtime, ctx, { provider: "anthropic", model })).not.toThrow();
  // Another server, a DM and the member's own row are not covered.
  expect(runtime.canUse("anthropic-opus-5-5", "g2", "member")).toBe(false);
  expect(runtime.canUse("anthropic-opus-5-5", undefined, "member")).toBe(false);
  runtime.snapshot.user_overrides.member = {
    ...runtime.snapshot.user_overrides.member!,
    selection: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  };
  expect(runtime.resolve("g1", "member").selection.provider).toBe("codex_plus");

  // A fixed model shares only itself; Claude Max keeps its per-user floor.
  await runtime.patch("g3", { preset: "anthropic-haiku-5-5" }, "owner");
  expect(runtime.canUse("anthropic-haiku-5-5", "g3", "member")).toBe(true);
  expect(runtime.canUse("anthropic-opus-5-5", "g3", "member")).toBe(false);
});

test("a child asked for the auto preset keeps the parent's route or runs the fallback", async () => {
  const runtime = new Runtime(config());
  runtime.snapshot.user_roles.owner = "premium";
  await runtime.patch("g1", { preset: "anthropic-auto", subagent_model: { mode: "fixed", preset: "anthropic-auto" } }, "owner");
  const ctx = context();
  const parent = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", routed: true };
  expect(selectChild(runtime, ctx, parent, {})).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", routed: true });
  expect(selectChild(runtime, ctx, { provider: "codex_plus", model: "gpt-6-luna", effort: "max" }, {}))
    .toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", routed: true });
});

test("a conversation keeps its route until the cache expires; a fallback is not kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-route-"));
  const bot = new Hibana(loadConfig({
    HIBANA_DATA_DIR: dir, PROVIDER: "anthropic", LLM_MODEL: "auto", ANTHROPIC_API_KEY: "anthropic-fixture",
    JEV_API_KEY: "jev-fixture", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", LOG_DIR: "",
  }), pino({ enabled: false }));
  const ctx: Context = { channelId: "10000", userId: "20000", botId: "30000", thread: false, depth: 0, delivered: false };
  bot.runtime.snapshot.user_roles[ctx.userId] = "premium";
  bot.client.channels.fetch = (async () => ({
    id: ctx.channelId, isSendable: () => true, sendTyping: async () => {},
    send: async (value: { content: string }) => { sent.push(value.content); order.push("notice"); return { id: "40000", edit: async () => {} }; },
  })) as never;
  const sent: string[] = [];
  const order: string[] = [];
  const notices = () => sent.filter((text) => text.startsWith("Auto Routing"));
  const notice = () => notices().at(-1);
  bot.tools.tools = () => [];
  let now = Date.now();
  bot.routes = new RouteMemory(() => now);
  let score: number | Error = 5, routings = 0, requested = "none";
  bot.tools.jev.decide = (async (input: { questions: Json }) => {
    // Other Jev decisions share this client; only routing is under test.
    if (!input.questions.difficulty) throw new Error("not routing");
    routings++;
    if (score instanceof Error) throw score;
    return scored(score, requested)();
  }) as never;
  const used: string[] = [];
  bot.llm.complete = async (selection) => {
    if (order.length < 2) order.push("model");
    used.push(`${selection.model}/${selection.effort}`);
    return { message: { role: "assistant", content: "ok" }, usage, incomplete: false };
  };
  try {
    await bot.respond("難しい設計の相談", { ...ctx });
    expect(used.at(-1)).toBe("claude-opus-5-5/medium");
    // The route is announced before the model runs, as its own message, and
    // the stored history does not carry it.
    // (The failing completion-check mock adds a progress message in between.)
    expect([sent[0], sent.at(-1)]).toEqual(["Auto Routing: **Opus 5.5 Medium**", "ok"]);
    expect(order.slice(0, 2)).toEqual(["notice", "model"]);
    expect(JSON.stringify(bot.history.get(ctx.channelId, undefined, JSON.stringify(bot.runtime.resolve(undefined, ctx.userId).selection), false, 0))).not.toContain("Auto Routing");
    // An easy follow-up stays on the routed model without asking Jev.
    score = 0;
    await bot.respond("ありがとう", { ...ctx });
    expect(used.at(-1)).toBe("claude-opus-5-5/medium");
    expect(routings).toBe(1);
    // Only a newly chosen route is announced, not a turn that keeps it.
    expect(notices()).toHaveLength(1);
    // Naming a model asks Jev again; a mention keeps the route, a request replaces it.
    await bot.respond("Sonnet と Opus の違いは？", { ...ctx });
    expect(used.at(-1)).toBe("claude-opus-5-5/medium");
    expect(notices()).toHaveLength(1);
    requested = "sonnet";
    await bot.respond("ここからは Sonnet で答えて", { ...ctx });
    expect(used.at(-1)).toBe("claude-sonnet-5-5/medium");
    expect(notice()).toBe("Auto Routing: **Sonnet 5.5 Medium**");
    requested = "none";
    await bot.respond("続けて", { ...ctx });
    expect(used.at(-1)).toBe("claude-sonnet-5-5/medium");
    expect(routings).toBe(3);
    expect(notices()).toHaveLength(2);
    requested = "opus";
    score = 5;
    await bot.respond("Opus に戻して", { ...ctx });
    expect(used.at(-1)).toBe("claude-opus-5-5/medium");
    routings = 1;
    requested = "none";
    score = 0;
    // The turn above renewed the cache, so the hour counts from it.
    now += ROUTE_CACHE_TTL_MS - 1;
    await bot.respond("続き", { ...ctx });
    expect(routings).toBe(1);
    expect(notices()).toHaveLength(3);
    // Past the cache TTL the conversation is routed, and announced, again.
    now += ROUTE_CACHE_TTL_MS;
    await bot.respond("こんにちは", { ...ctx });
    expect(used.at(-1)).toBe("claude-haiku-5-5/medium");
    expect(routings).toBe(2);
    expect(notices()).toEqual([
      "Auto Routing: **Opus 5.5 Medium**", "Auto Routing: **Sonnet 5.5 Medium**",
      "Auto Routing: **Opus 5.5 Medium**", "Auto Routing: **Haiku 5.5 Medium**",
    ]);
    // Cleared history has no cache to keep.
    bot.history.clear(ctx.channelId);
    score = new Error("Jev: HTTP 503");
    await bot.respond("もう一度", { ...ctx });
    expect(used.at(-1)).toBe("claude-haiku-5-5/high");
    expect(notice()).toBe("Auto Routing: **Haiku 5.5 High**");
    expect(routings).toBe(3);
    expect(notices()).toHaveLength(5);
    // While Jev stays down every turn falls back; only the first one says so.
    await bot.respond("まだ？", { ...ctx });
    expect(used.at(-1)).toBe("claude-haiku-5-5/high");
    expect(routings).toBe(4);
    expect(notices()).toHaveLength(5);
    score = 3;
    await bot.respond("実装して", { ...ctx });
    expect(used.at(-1)).toBe("claude-sonnet-5-5/high");
    expect(routings).toBe(5);
    expect(notice()).toBe("Auto Routing: **Sonnet 5.5 High**");
    expect(notices()).toHaveLength(6);
    expect(new Set(used).has("auto/high")).toBe(false);
  } finally { await bot.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Anthropic turns run without subagents, whatever the stored mode", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  runtime.snapshot.user_roles.owner = "premium";
  expect(runtime.resolve("g1", "member")).toMatchObject({ subagent_enabled: true, multi_agent: true });
  for (const preset of ["anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5"]) {
    await runtime.patch("g1", { preset, subagent_enabled: true, ultra_mode: true }, "owner");
    expect(runtime.resolve("g1", "member")).toMatchObject({ subagent_enabled: false, ultracode: false });
  }
  // The stored switch applies again under another provider.
  await runtime.patch("g1", { preset: "sol" }, "owner");
  expect(runtime.resolve("g1", "member").subagent_enabled).toBe(true);
});
