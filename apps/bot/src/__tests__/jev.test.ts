import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { loadConfig } from "../config";
import {
  JevClient,
  jevInputSchema,
  JEV_MODEL,
  JEV_NOTICE_HEADER,
  JEV_TASK_NOTICE_HEADER,
} from "../jev";
import { Runtime } from "../runtime";
import { Agent } from "../agent";
import { LlmClient } from "../llm";
import { ToolRegistry } from "../tools";
import { assemblePrompt } from "../harness";
import {
  applyUserOverridePatch,
  emptyUserOverride,
} from "@hibana/shared/settings";
import type { Context } from "../types";

const input = jevInputSchema.parse({
  state: {
    source: "Refunds are available within 30 days.",
    claim: "Refunds are available.",
  },
  questions: {
    supported: {
      type: "noul",
      instructions: "Does the source support the claim?",
    },
    verdict: {
      type: "choice",
      instructions: "Classify the claim against the source.",
      criteria: { supported: "Supported", unknown: "Insufficient evidence" },
    },
    relevance: {
      type: "score",
      instructions: "How relevant is the source to the claim?",
      criteria: ["Irrelevant", "Partly relevant", "Directly relevant"],
    },
  },
});
const result = () =>
  ({
    model: "typesafe/jev-1.13-20260917",
    answers: {
      supported: { type: "noul", noul: 0.98 },
      verdict: {
        type: "choice",
        choice: "supported",
        confidence: 0.96,
        probabilities: { supported: 0.98, unknown: 0.02 },
      },
      relevance: {
        type: "score",
        score: 1.8,
        confidence: 0.8,
        probabilities: { "0": 0, "1": 0.2, "2": 0.8 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
  }) as const;
const config = () =>
  loadConfig({
    RUNTIME_STATE_PATH: "",
    CODEX_PLUS_API_KEY: "fixture",
    JEV_API_KEY: "jev-fixture",
    OPENROUTER_API_KEY: "chat-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    SUBAGENT_MAX_CONCURRENT: "1",
  });
const context: Context = {
  guildId: "100",
  channelId: "200",
  userId: "300",
  botId: "400",
  thread: false,
  depth: 0,
  delivered: false,
};

test("Jev uses the Decisions endpoint and its own key, preserving all three typed answers", async () => {
  const client = new JevClient(config(), async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer jev-fixture",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: JEV_MODEL,
      ...input,
    });
    expect(init?.redirect).toBe("error");
    return Response.json(result());
  });
  const answer = await client.decide(input);
  expect(answer.answers).toEqual(result().answers);
  expect(answer.usage.total_tokens).toBe(110);
  expect(answer.cost).toBe(0.00001);
});

test("Jev rejects malformed or oversized questions before any request", () => {
  for (const questions of [
    {},
    { bad: { type: "chat", instructions: "write a poem" } },
    {
      bad: { type: "choice", instructions: "pick", criteria: { only: "one" } },
    },
    { bad: { type: "score", instructions: "score", criteria: ["one"] } },
    { bad: { type: "noul", instructions: " " } },
  ])
    expect(jevInputSchema.safeParse({ ...input, questions }).success).toBe(
      false,
    );
  expect(
    jevInputSchema.safeParse({ ...input, state: "x".repeat(60001) }).success,
  ).toBe(false);
});

test("Jev never falls back to another credential and aborts before sending", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json(result());
  };
  const cfg = config();
  cfg.jevApiKey = "";
  await expect(new JevClient(cfg, fetcher).decide(input)).rejects.toThrow(
    "Missing JEV_API_KEY",
  );
  await expect(
    new JevClient(config(), fetcher).decide(input, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("Jev reports HTTP errors without leaking provider bodies and retries transient errors", async () => {
  await expect(
    new JevClient(
      config(),
      async () => new Response("private provider data", { status: 401 }),
    ).decide(input),
  ).rejects.toThrow("Jev: HTTP 401");
  let calls = 0;
  const client = new JevClient(config(), async () =>
    ++calls === 1
      ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
      : Response.json(result()),
  );
  expect((await client.decide(input)).model).toBe(result().model);
  expect(calls).toBe(2);
});

test("Jev rejects missing, mismatched and out-of-range decisions", async () => {
  for (const answers of [
    {},
    { ...result().answers, supported: { type: "noul", noul: 1.2 } },
    { ...result().answers, verdict: { type: "choice", choice: "invented" } },
    { ...result().answers, relevance: { type: "score", score: 3 } },
    { ...result().answers, extra: { type: "noul", noul: 0.5 } },
  ]) {
    const client = new JevClient(config(), async () =>
      Response.json({ ...result(), answers }),
    );
    await expect(client.decide(input)).rejects.toThrow("Jev returned");
  }
});

test("Jev opt-out is enforced at execution, resolves independent user/guild/DM settings, and never changes the chat preset", async () => {
  const runtime = new Runtime(config());
  const registry = new ToolRegistry(
    runtime,
    new Client({ intents: [] }),
    new Agent(new LlmClient(runtime.config)),
  );
  let calls = 0;
  const notices: string[] = [];
  registry.jev.decide = async () => {
    expect(notices.at(-1)).toBe(`${JEV_NOTICE_HEADER}(${notices.length}回目)`);
    calls++;
    return {
      model: JEV_MODEL,
      answers: result().answers,
      usage: {
        prompt_tokens: 1,
        completion_tokens: 0,
        total_tokens: 1,
        cached_tokens: 0,
      },
      cost: 0,
    };
  };
  const ctx = {
    ...context,
    notify: async (text: string) => {
      notices.push(text);
    },
  };
  const exposed = (c = ctx) =>
    registry.tools(c).some((t) => t.function.name === "mcp__agent__run_jev");
  try {
    const selected = runtime.resolve(ctx.guildId, ctx.userId).selection;
    expect(exposed()).toBe(true);
    await runtime.patch("100", { subagent_model: { mode: "fixed", preset: "sol" } }, ctx.userId);
    await registry.execute("mcp__agent__run_jev", input, ctx);
    expect(runtime.resolve(ctx.guildId, ctx.userId).selection).toEqual(
      selected,
    );
    expect(ctx.delivered).toBe(false);
    expect(exposed({ ...ctx, depth: 1 })).toBe(false);
    await expect(
      registry.execute("run_jev", input, { ...ctx, depth: 1 }),
    ).rejects.toThrow("Tool disabled");
    await runtime.patch("100", { jev_enabled: false }, ctx.userId);
    expect(exposed()).toBe(false);
    await expect(registry.execute("run_jev", input, ctx)).rejects.toThrow(
      "Tool disabled",
    );
    expect(runtime.resolve("101", ctx.userId).jev_enabled).toBe(true);
    expect(runtime.resolve(undefined, ctx.userId).jev_enabled).toBe(true);
    runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(
      emptyUserOverride(),
      { jev_enabled: true },
    );
    expect(exposed()).toBe(true);
    runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(
      emptyUserOverride(),
      { jev_enabled: false },
    );
    expect(runtime.resolve(undefined, ctx.userId).jev_enabled).toBe(false);
    expect(runtime.resolve("101", "other").jev_enabled).toBe(true);
    runtime.snapshot.user_overrides[ctx.userId] = emptyUserOverride();
    await runtime.patch("100", { jev_enabled: null }, ctx.userId);
    expect(exposed()).toBe(true);
    const prompt = JSON.stringify(await assemblePrompt(runtime, ctx, ""));
    expect(prompt).toContain("You may proactively call mcp__agent__run_jev");
    expect(prompt).toContain("Do not spawn sub-agents");
    runtime.config.jevEnabled = false;
    // Saved settings stay stable when process defaults change.
    expect(exposed()).toBe(true);
    runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(
      emptyUserOverride(), { jev_enabled: false },
    );
    expect(exposed()).toBe(false);
    expect(
      JSON.stringify(await assemblePrompt(runtime, ctx, "")),
    ).not.toContain("Jev evaluation is enabled");
    runtime.config.jevEnabled = true;
    runtime.snapshot.user_overrides[ctx.userId] = emptyUserOverride();
    runtime.config.jevApiKey = "";
    expect(exposed()).toBe(false);
    runtime.config.jevApiKey = "jev-fixture";
    runtime.config.subagentEnabled = false;
    expect(exposed()).toBe(false);
    expect(calls).toBe(1);
  } finally {
    await registry.close();
  }
});

test("queued Jev calls stop when disabled and invalid input never posts a notice", async () => {
  const runtime = new Runtime(config());
  const registry = new ToolRegistry(
    runtime,
    new Client({ intents: [] }),
    new Agent(new LlmClient(runtime.config)),
  );
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const notices: string[] = [];
  const ctx = {
    ...context,
    notify: async (text: string) => {
      notices.push(text);
    },
  };
  registry.jev.decide = async () => {
    started();
    await gate;
    throw new Error("fixture failure");
  };
  try {
    await expect(
      registry.execute("run_jev", { ...input, questions: {} }, ctx),
    ).rejects.toThrow();
    expect(notices).toHaveLength(0);
    const first = registry.execute("run_jev", input, ctx).catch((e) => e);
    await running;
    const second = registry.execute("run_jev", input, ctx).catch((e) => e);
    await runtime.patch("100", { jev_enabled: false }, ctx.userId);
    release();
    expect(await first).toMatchObject({ message: "fixture failure" });
    expect(await second).toMatchObject({
      message: "Jev is disabled for this context",
    });
    expect(notices).toHaveLength(1);
  } finally {
    release();
    await registry.close();
  }
});

test("Jev notices are one line and distinguish evaluation from the task loop", () => {
  expect(JEV_NOTICE_HEADER).toBe("サブ: Jev を呼び出します");
  expect(JEV_TASK_NOTICE_HEADER).toBe("サブ: Jev でタスクを進めます。");
  expect(JEV_NOTICE_HEADER).not.toContain("\n");
  expect(JEV_TASK_NOTICE_HEADER).not.toContain("\n");
});
