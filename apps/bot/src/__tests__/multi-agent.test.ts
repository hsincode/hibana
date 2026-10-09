import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { emptyGuild, emptyUserOverride } from "@hibana/shared/settings";
import { Agent, type AgentOptions } from "../agent";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import {
  formatSubagentStartNotice,
  MultiAgentSession,
  subagentModelTitle,
  subagentNoticeLine,
} from "../multi-agent";
import { assertChildSelection, forkMessages, selectChild, teamTools } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { assemblePrompt } from "../harness";
import { emptyUsage, type Context, type Json, type Message } from "../types";

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    LLM_MODEL: "gpt-6.1-sol",
    LLM_EFFORT: "ultra",
    CODEX_PLUS_API_KEY: "plus-fixture",
    CODEX_PRO_API_KEY: "pro-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    ...env,
  });
const context = (): Context => ({
  guildId: "g1",
  channelId: "c1",
  userId: "u1",
  botId: "bot",
  thread: false,
  depth: 0,
  delivered: false,
});
const call = (name: string, args: Json) => ({
  id: crypto.randomUUID(),
  type: "function",
  function: { name: `agents__${name}`, arguments: JSON.stringify(args) },
});
test("subagent start notice uses the catalog name and one task line", () => {
  const luna = { provider: "codex_plus", model: "gpt-6-luna", effort: "max" };
  expect(subagentModelTitle(luna)).toBe("GPT 6 Luna");
  expect(subagentModelTitle({ provider: "codex_pro", model: "gpt-6-luna" })).toBe(
    "GPT 6 Luna",
  );
  expect(
    subagentModelTitle({ provider: "claude_kiro", model: "claude-opus-5" }),
  ).toBe("Claude Opus 5");
  expect(
    subagentModelTitle({ provider: "custom", model: "gpt-oss-20b" }),
  ).toBe("GPT Oss 20b");
  expect(
    formatSubagentStartNotice(luna, "  ワークスペースの構成を調べます。  "),
  ).toBe("サブエージェント: GPT 6 Luna\nワークスペースの構成を調べます。");
  const long = "あ".repeat(200);
  expect(formatSubagentStartNotice(luna, long)).toBe(
    `サブエージェント: GPT 6 Luna\n${"あ".repeat(159)}…`,
  );
  expect(subagentNoticeLine("ワークスペースを調べます")).toBe(
    "ワークスペースを調べます",
  );
  expect(() => subagentNoticeLine("Inspect the workspace and report the layout.")).toThrow(
    "Japanese",
  );
});

const options = (ctx: Context, runtime: Runtime): AgentOptions => ({
  context: ctx,
  selection: runtime.config.selection,
  messages: [{ role: "user", content: "Complete the task", turnStart: true }],
  tools: [],
  maxRounds: 50,
  temperature: 0.7,
  nativeSearch: false,
  execute: (name, args, c) =>
    c.team!.execute(name.replace(/^agents__/, ""), args, c),
});

test("model/effort policies independently enforce same, fixed and agent choice, including personal auto overrides", () => {
  const runtime = new Runtime(config()),
    ctx = context(),
    parent = runtime.config.selection;
  expect(selectChild(runtime, ctx, parent, {})).toEqual(parent);
  runtime.snapshot.guilds.g1 = {
    ...emptyGuild(),
    subagent_model: { mode: "fixed", preset: "pro-luna" },
    subagent_effort: { mode: "fixed", effort: "low" },
  };
  expect(
    selectChild(runtime, ctx, parent, {
      model: "sol",
      reasoning_effort: "high",
    }),
  ).toEqual({ provider: "codex_pro", model: "gpt-6-luna", effort: "low" });
  runtime.snapshot.user_overrides.u1 = {
    ...emptyUserOverride(),
    subagent_model: { mode: "same" },
    subagent_effort: { mode: "same" },
  };
  expect(
    selectChild(runtime, ctx, parent, {
      model: "pro-luna",
      reasoning_effort: "low",
    }),
  ).toEqual(parent);
  const schema = teamTools(runtime, ctx)[0]!.function.parameters
    .properties as Json;
  expect(schema.model).toBeUndefined();
  expect(schema.reasoning_effort).toBeUndefined();
  runtime.snapshot.user_overrides.u1 = {
    ...emptyUserOverride(),
    subagent_model: { mode: "auto" },
    subagent_effort: { mode: "auto" },
  };
  expect(
    selectChild(runtime, ctx, parent, {
      model: "plus-luna",
      reasoning_effort: "high",
    }),
  ).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "high" });
  expect(selectChild(runtime, ctx, parent, { model: "plus-luna" }).effort).toBe(
    "max",
  );
  expect(runtime.resolve("g2", "u2").subagent_model).toEqual({ mode: "auto" });
  expect(() => selectChild(runtime, ctx, parent, { model: "fable-5" })).toThrow(
    "unavailable",
  );
  runtime.config.endpoints.codex_pro!.apiKey = "";
  expect(() =>
    selectChild(runtime, ctx, parent, { model: "pro-luna" }),
  ).toThrow("unavailable");
  expect(() =>
    selectChild(runtime, ctx, parent, { reasoning_effort: "invalid" }),
  ).toThrow();
});

test("fork history follows HsinCLI recent-turn policy and repairs in-flight tool batches", () => {
  const runtime = new Runtime(config());
  const messages: Message[] = [
    { role: "system", content: "Standing rules" },
    {
      role: "developer",
      content: "<multi_agent_role>parent identity</multi_agent_role>",
    },
    { role: "user", content: "Old turn", turnStart: true },
    { role: "assistant", content: "Old reply" },
    { role: "user", content: "Current turn", turnStart: true },
    { role: "user", content: "Synthetic feedback", internal: true },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        call("spawn_agent", {
          task_name: "child",
          message: "Do work",
        }) as never,
      ],
      providerBlocks: [{ opaque: true }],
    },
  ];
  const inherited = forkMessages(messages, undefined, runtime);
  expect(inherited.map((m) => m.content)).not.toContain("Old turn");
  expect(inherited.map((m) => m.content)).toContain("Current turn");
  expect(inherited.map((m) => m.content)).not.toContain(
    "<multi_agent_role>parent identity</multi_agent_role>",
  );
  expect(inherited.at(-1)?.role).toBe("tool");
  expect(inherited.some((m) => m.providerBlocks)).toBe(false);
  expect(forkMessages(messages, "none", runtime)).toEqual([
    { role: "system", content: "Standing rules" },
  ]);
  expect(() => forkMessages(messages, "all", runtime)).toThrow();
  expect(() => forkMessages(messages, "0", runtime)).toThrow();
  runtime.config.subagentForkMaxTurns = 3;
  expect(() => forkMessages(messages, "4", runtime)).toThrow();
  runtime.config.subagentForkAllowAll = true;
  expect(() => forkMessages(messages, "all", runtime)).toThrow();
  runtime.config.subagentForkMaxTurns = undefined;
  expect(
    forkMessages(messages, "all", runtime).some(
      (m) => m.content === "Old turn",
    ),
  ).toBe(true);
});

test.each([{ LLM_EFFORT: "ultra" }, { LLM_EFFORT: "low", ULTRA_MODE: "true" }])(
  "real agent loop runs asynchronous children and grandchildren with %j", async (env) => {
  const runtime = new Runtime(config(env));
  const seen = new Map<string, number>();
  const requests: { path: string; messages: Message[]; tools: string[] }[] = [];
  const llm = new LlmClient(runtime.config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const messages: Message[] = body.messages;
    const role = [...messages]
      .reverse()
      .find((m) => m.content?.startsWith("<multi_agent_role>"))!.content!;
    const path = /You are (\/root[^,]*)/.exec(role)![1]!;
    const round = seen.get(path) ?? 0;
    seen.set(path, round + 1);
    requests.push({
      path,
      messages,
      tools: body.tools.map(
        (t: { function: { name: string } }) => t.function.name,
      ),
    });
    expect(body.reasoning_effort).toBe(env.LLM_EFFORT === "ultra" ? "max" : "low");
    // Ultra is Ultracode now: individual agents keep the explicit Codex
    // policy and the standing opt-in belongs to the Workflow tool.
    expect(messages.some(m => m.content?.includes("Do not spawn sub-agents unless the user"))).toBe(true);
    expect(messages.some(m => m.content?.includes("Proactive multi-agent delegation is active"))).toBe(false);
    expect(messages.some((m) => "turnStart" in m || "internal" in m)).toBe(
      false,
    );
    let calls;
    if (path === "/root" && round === 0)
      calls = [
        call("spawn_agent", {
          task_name: "worker",
          message: "Investigate and delegate a check",
          notice: "調査を分担して確認します",
        }),
        call("spawn_agent", {
          task_name: "sibling",
          message: "Independent check",
          notice: "別件を独立して確認します",
        }),
      ];
    if (path === "/root/worker" && round === 0)
      calls = [
        call("spawn_agent", {
          task_name: "check",
          message: "Nested check",
          notice: "細部を追加で確認します",
          fork_turns: "none",
        }),
      ];
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: calls ? null : `${path} result`,
            tool_calls: calls,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });
  const agent = new Agent(llm),
    client = new Client({ intents: [] }),
    registry = new ToolRegistry(runtime, client, agent);
  const ctx = context(),
    base = options(ctx, runtime);
  base.messages = [
    ...(await assemblePrompt(runtime, ctx, "")),
    ...base.messages,
  ];
  base.execute = (name, args, c) => registry.execute(name, args, c);
  const session = new MultiAgentSession(runtime, agent, (c) =>
    registry.tools(c),
  );
  try {
    const result = await session.runRoot(base);
    expect(result.text).toBe("/root result");
    expect([...seen.keys()].sort()).toEqual([
      "/root",
      "/root/sibling",
      "/root/worker",
      "/root/worker/check",
    ]);
    expect(
      result.messages.some(
        (m) =>
          m.content?.includes("Message Type: FINAL_ANSWER") &&
          m.content.includes("/root/worker result"),
      ),
    ).toBe(true);
    expect(
      requests
        .filter((r) => r.path === "/root/worker")
        .at(-1)!
        .messages.some((m) => m.content?.includes("/root/worker/check result")),
    ).toBe(true);
    expect(
      requests.every(
        (r) =>
          r.tools.includes("agents__spawn_agent") &&
          r.tools.includes("request_user_input"),
      ),
    ).toBe(true);
    // Workflow and TaskStop belong to root, like Claude Code's main loop.
    expect(requests.every((r) => r.tools.includes("Workflow") === (r.path === "/root"))).toBe(true);
    expect(requests.every((r) => r.tools.includes("TaskStop") === (r.path === "/root"))).toBe(true);
    expect(result.usage.total_tokens).toBe(requests.length * 3);
    await expect(session.execute("list_agents", {}, ctx)).rejects.toThrow(
      "no longer active",
    );
  } finally {
    await registry.close();
    client.destroy();
  }
});

// Drive the scheduler directly so cancellation and steering races are repeatable
// without network timing or sleeping for the production wait timeout.
test("mailbox-only messages, followups, interrupts, capacity and task isolation", async () => {
  const runtime = new Runtime(config());
  runtime.config.subagentConcurrency = 1;
  let entered!: () => void;
  let observed!: () => void;
  const childEntered = new Promise<void>((r) => (entered = r));
  const secondEntered = new Promise<void>((r) => (observed = r));
  let childRuns = 0;
  let childContext: Context | undefined;
  const agent = {
    run: async (o: AgentOptions) => {
      o.observeMessages?.(o.messages);
      const c = o.context;
      if (c.agentPath !== "/root") {
        childContext = c;
        const mailbox = o.takeSteering!();
        childRuns++;
        if (childRuns === 1) {
          expect(mailbox.some((m) => m.content?.includes("initial"))).toBe(
            true,
          );
          entered();
          await new Promise((_, reject) =>
            c.signal!.addEventListener(
              "abort",
              () => reject(c.signal!.reason),
              { once: true },
            ),
          );
        } else {
          expect(mailbox.some((m) => m.content?.includes("queued only"))).toBe(
            true,
          );
          expect(mailbox.some((m) => m.content?.includes("resume work"))).toBe(
            true,
          );
          observed();
        }
        return {
          text: "child done",
          messages: o.messages,
          usage: emptyUsage(),
          rounds: 1,
        };
      }
      const invoke = (name: string, a: Json) => c.team!.execute(name, a, c);
      const child = (await invoke("spawn_agent", {
        task_name: "worker",
        message: "initial",
        notice: "最初の調査を始めます",
      })) as { agent_id: string };
      await childEntered;
      await expect(
        invoke("spawn_agent", {
          task_name: "over_cap",
          message: "work",
          notice: "追加の調査を始めます",
        }),
      ).rejects.toThrow("slots");
      await expect(
        invoke("send_message", {
          target: "/root/foreign",
          message: "cross task",
        }),
      ).rejects.toThrow("not found");
      await expect(
        invoke("followup_task", { target: "/root", message: "work" }),
      ).rejects.toThrow("root");
      await expect(
        invoke("interrupt_agent", { target: "/root" }),
      ).rejects.toThrow("root");
      await expect(
        c.team!.execute("list_agents", {}, { ...c, userId: "another" }),
      ).rejects.toThrow("context");
      await expect(
        c.team!.execute(
          "interrupt_agent",
          { target: child.agent_id },
          childContext!,
        ),
      ).rejects.toThrow("yourself");
      await invoke("send_message", {
        target: child.agent_id,
        message: "queued only",
      });
      expect(childRuns).toBe(1);
      await invoke("interrupt_agent", { target: child.agent_id });
      await invoke("followup_task", {
        target: "worker",
        message: "resume work",
        notice: "中断した調査を再開します",
      });
      await secondEntered;
      await o.beforeFinal!();
      await invoke("send_message", { target: "worker", message: "stay idle" });
      expect(childRuns).toBe(2);
      const listing = (await invoke("list_agents", {
        path_prefix: "/root/worker",
      })) as { agents: { task_name: string }[] };
      expect(listing.agents.map((a) => a.task_name)).toEqual(["/root/worker"]);
      return {
        text: "done",
        messages: o.messages,
        usage: emptyUsage(),
        rounds: 1,
      };
    },
  } as Agent;
  const session = new MultiAgentSession(runtime, agent, () => []);
  expect((await session.runRoot(options(context(), runtime))).text).toBe(
    "done",
  );
});

test("root cancellation wakes waits, stops descendants and retains root context identity for cleanup", async () => {
  const runtime = new Runtime(config());
  const shutdown = new AbortController();
  const ctx = { ...context(), signal: shutdown.signal };
  let ready!: () => void;
  const childStarted = new Promise<void>((r) => (ready = r));
  let childStopped = false;
  const agent = {
    run: async (o: AgentOptions) => {
      o.observeMessages?.(o.messages);
      const c = o.context;
      if (c.agentPath === "/root") {
        expect(c).toBe(ctx);
        await c.team!.execute(
          "spawn_agent",
          { task_name: "worker", message: "work", notice: "作業を進めます" },
          c,
        );
        await childStarted;
        const wait = c.team!.execute("wait_agent", { timeout_ms: 60000 }, c);
        shutdown.abort(new Error("Shutdown fixture"));
        await wait;
      } else {
        ready();
        try {
          await new Promise((_, reject) =>
            c.signal!.addEventListener(
              "abort",
              () => reject(c.signal!.reason),
              { once: true },
            ),
          );
        } finally {
          childStopped = true;
        }
      }
      return {
        text: "unused",
        messages: o.messages,
        usage: emptyUsage(),
        rounds: 1,
      };
    },
  } as Agent;
  const team = new MultiAgentSession(runtime, agent, () => []);
  await expect(team.runRoot(options(ctx, runtime))).rejects.toThrow(
    "Shutdown fixture",
  );
  expect(childStopped).toBe(true);
  expect(ctx.team).toBeUndefined();
  expect(ctx.signal).toBe(shutdown.signal);
});

test("user steering interrupts wait_agent without cancelling the task tree", async () => {
  const runtime = new Runtime(config());
  const steering = new AbortController();
  const agent = {
    run: async (o: AgentOptions) => {
      o.observeMessages?.(o.messages);
      const wait = o.context.team!.execute(
        "wait_agent",
        { timeout_ms: 60000 },
        o.context,
      );
      steering.abort();
      expect(await wait).toEqual({
        message: "Wait interrupted by new input.",
        timed_out: false,
      });
      expect(o.context.signal?.aborted).toBe(false);
      return {
        text: "steered",
        messages: o.messages,
        usage: emptyUsage(),
        rounds: 1,
      };
    },
  } as Agent;
  const team = new MultiAgentSession(runtime, agent, () => []);
  const rootOptions = {
    ...options(context(), runtime),
    requestSignal: () => steering.signal,
  };
  expect((await team.runRoot(rootOptions)).text).toBe("steered");
});

test("Discord and agent messages have unique schemas and independent dispatch", async () => {
  const runtime = new Runtime(config());
  const agent = new Agent(new LlmClient(runtime.config));
  const registry = new ToolRegistry(runtime, new Client({ intents: [] }), agent);
  const invocations: { kind: string; name: string; args: Json }[] = [];
  const ctx = context();
  ctx.team = { execute: async (name: string, args: Json) => {
    invocations.push({ kind: "agent", name, args }); return { ok: true };
  } } as unknown as MultiAgentSession;
  registry.discord.execute = async (name, args) => {
    invocations.push({ kind: "discord", name, args }); return { ok: true };
  };
  const tools = registry.tools(ctx);
  expect(new Set(tools.map(t => t.function.name)).size).toBe(tools.length);
  expect(tools.find(t => t.function.name === "agents__send_message")?.function.parameters.required).toEqual(["target", "message"]);
  expect(tools.find(t => t.function.name === "mcp__discord__send_message")?.function.parameters.properties).toHaveProperty("channel_id");
  await registry.execute("agents__send_message", { target: "worker", message: "continue" }, ctx);
  await registry.execute("mcp__discord__send_message", { channel_id: "12345", content: "hello" }, ctx);
  expect(invocations.map(i => [i.kind, i.name])).toEqual([["agent", "send_message"], ["discord", "send_message"]]);
  await expect(registry.execute("agents__send_message", { channel_id: "12345", content: "wrong schema" }, ctx)).rejects.toThrow("Invalid arguments");
  await expect(registry.execute("mcp__discord__send_message", { target: "worker", message: "wrong schema" }, ctx)).rejects.toThrow("Invalid arguments");
  const withoutTeam = { ...ctx, team: undefined };
  expect(registry.tools(withoutTeam).some(t => t.function.name === "agents__send_message")).toBe(false);
  expect(registry.tools(withoutTeam).some(t => t.function.name === "mcp__discord__send_message")).toBe(true);
  await expect(registry.execute("agents__send_message", { target: "worker", message: "no session" }, withoutTeam)).rejects.toThrow();
});


test("ChatGPT children use master-account availability for inherited and fixed policies", () => {
  const runtime = new Runtime(config({ WEB_API_URL: "https://settings.example.com", WEB_INTERNAL_TOKEN: "fixture" }));
  const ctx = context();
  const parent = { provider: "chatgpt", model: "gpt-6-luna", effort: "high" };
  runtime.snapshot.chatgpt_available = true;
  expect(runtime.config.endpoints.chatgpt?.apiKey).toBeFalsy();
  expect(runtime.canSelect("chatgpt-luna", ctx.userId)).toBe(true);
  for (const policy of [{ mode: "auto" }, { mode: "same" }, { mode: "fixed", preset: "chatgpt-luna" }] as const) {
    runtime.snapshot.guilds.g1 = { ...emptyGuild(), subagent_model: policy, subagent_effort: { mode: "same" } };
    expect(selectChild(runtime, ctx, parent, {})).toEqual(parent);
  }
  runtime.snapshot.guilds.g1!.subagent_model = { mode: "auto" };
  expect(selectChild(runtime, ctx, runtime.config.selection, { model: "chatgpt-luna" }).provider).toBe("chatgpt");

  // Spawn and follow-up share this guard; dormant children must lose access
  // when the master account is disabled, even though their model is unchanged.
  runtime.snapshot.chatgpt_available = false;
  expect(() => assertChildSelection(runtime, ctx, parent)).toThrow("unavailable");
  runtime.snapshot.chatgpt_available = true;
  runtime.snapshot.unpublished_presets = ["chatgpt-luna"];
  expect(() => assertChildSelection(runtime, ctx, parent)).toThrow("unavailable");
  runtime.snapshot.unpublished_presets = [];
  runtime.snapshot.premium_presets = ["chatgpt-luna"];
  expect(() => assertChildSelection(runtime, ctx, parent)).toThrow("unavailable");
  runtime.snapshot.user_roles[ctx.userId] = "premium";
  expect(() => assertChildSelection(runtime, ctx, parent)).not.toThrow();
  runtime.config.webApiUrl = "";
  expect(() => assertChildSelection(runtime, ctx, parent)).toThrow("unavailable");
});

test("master-account availability never supplies credentials for other child providers", () => {
  const runtime = new Runtime(config({ CODEX_PRO_API_KEY: "", WEB_API_URL: "https://settings.example.com", WEB_INTERNAL_TOKEN: "fixture" }));
  runtime.snapshot.chatgpt_available = true;
  expect(() => selectChild(runtime, context(), runtime.config.selection, { model: "pro-luna" })).toThrow("unavailable");
  expect(() => assertChildSelection(runtime, context(), { provider: "custom", model: "custom-model" })).toThrow("unavailable");
});

test("Ultra completes an inherited ChatGPT worker through the agent loop", async () => {
  const runtime = new Runtime(config({
    PROVIDER: "chatgpt", LLM_MODEL: "gpt-6-luna",
    WEB_API_URL: "https://settings.example.com", WEB_INTERNAL_TOKEN: "fixture",
  }));
  runtime.snapshot.chatgpt_available = true;
  const llm = new LlmClient(runtime.config);
  const visited = new Set<string>();
  let rootCalls = 0;
  llm.complete = async (selection, messages, tools) => {
    expect(selection.provider).toBe("chatgpt");
    expect(messages.some(m => m.content?.includes("Do not spawn sub-agents unless the user"))).toBe(true);
    expect(tools.some(t => t.function.name === "agents__spawn_agent")).toBe(true);
    const identity = [...messages].reverse().find(m => m.content?.startsWith("<multi_agent_role>"))!.content!;
    const path = /You are (\/root[^,]*)/.exec(identity)![1]!;
    visited.add(path);
    const calls = path === "/root" && rootCalls++ === 0
      ? [call("spawn_agent", { task_name: "worker", message: "Independent check", notice: "独立した確認を進めます" })]
      : undefined;
    return { message: { role: "assistant", content: calls ? null : `${path} result`, tool_calls: calls as never }, usage: emptyUsage(), incomplete: false };
  };
  const agent = new Agent(llm), client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, agent);
  const ctx = context(), base = options(ctx, runtime);
  base.messages = [...await assemblePrompt(runtime, ctx, ""), ...base.messages];
  base.execute = (name, args, c) => registry.execute(name, args, c);
  try {
    const result = await new MultiAgentSession(runtime, agent, c => registry.tools(c)).runRoot(base);
    expect([...visited].sort()).toEqual(["/root", "/root/worker"]);
    expect(result.messages.some(m => m.content?.includes("Message Type: FINAL_ANSWER") && m.content.includes("/root/worker result"))).toBe(true);
  } finally { await registry.close(); client.destroy(); }
});
