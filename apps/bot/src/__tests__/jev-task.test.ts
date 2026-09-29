import { expect, test } from "bun:test";
import { Client } from "discord.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { JEV_MODEL } from "../jev";
import { formatJevTaskStatus, jevTaskSchema, runJevTask } from "../jev-task";
import { JEV_TASK_NOTICE_HEADER } from "../jev";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { applyUserOverridePatch, emptyUserOverride } from "@hibana/shared/settings";
import { emptyUsage, type Context, type Json } from "../types";

const context = (): Context => ({
  guildId: "100", channelId: "200", userId: "300", botId: "400",
  thread: false, depth: 0, delivered: false, notify: async () => {},
});
const choice = (selected = "a0") => ({
  model: JEV_MODEL,
  answers: { action: { type: "choice" as const, choice: selected, confidence: 0.8 } },
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cached_tokens: 0 },
  cost: 0.001,
});
const task = () => jevTaskSchema.parse({
  objective: "Inspect the prepared report and its source",
  state: { report: "report.txt" },
  actions: [
    { id: "source", description: "Read the source", tool: "read_file", arguments: { path: "source.txt" } },
    { id: "report", description: "Read the report after its source", tool: "read_file", arguments: { path: "report.txt" }, depends_on: ["source"] },
  ],
});

test("Jev sees fresh observations, only ready actions, and executes exact arguments once", async () => {
  const calls: string[] = [];
  const observedUsage: number[] = [];
  const statuses: string[] = [];
  const ctx = { ...context(), recordToolUsage: (u: ReturnType<typeof emptyUsage>) => { observedUsage.push(u.total_tokens); } };
  const result = await runJevTask(task(), {
    context: ctx, assertEnabled: () => {},
    report: async (text) => { statuses.push(text); },
    decide: async (input) => {
      const state = input.state as Json;
      expect(state.available_actions).toHaveLength(1);
      expect(state.observations).toHaveLength(calls.length);
      if (calls.length) expect(JSON.stringify(state.observations)).toContain("source.txt content");
      return choice();
    },
    execute: async (tool, args, c) => {
      expect(tool).toBe("read_file");
      expect(c.guildId).toBe(ctx.guildId);
      expect(c.userId).toBe(ctx.userId);
      expect(c.signal).toBeDefined();
      calls.push(String(args.path));
      return { content: args.path + " content" };
    },
  });
  expect(calls).toEqual(["source.txt", "report.txt"]);
  expect(result.status).toBe("completed_plan");
  expect(result.remaining).toEqual([]);
  expect(result.usage.total_tokens).toBe(22);
  expect(result.cost).toBe(0.002);
  expect(result.decisions.map((d) => d.action_id)).toEqual(["source", "report"]);
  expect(observedUsage).toEqual([11, 11]);
  expect(statuses.map((text) => text.split("\n")[0])).toEqual(
    [1, 2, 3, 4, 5].map((count) => `${JEV_TASK_NOTICE_HEADER}(${count}回目)`),
  );
});

test("invalid graphs and oversized plans are rejected before work", () => {
  for (const actions of [
    [task().actions[0], task().actions[0]],
    [{ ...task().actions[0], depends_on: ["missing"] }],
    [{ ...task().actions[0], depends_on: ["source"] }],
    [{ ...task().actions[0], depends_on: ["report"] }, task().actions[1]],
  ]) expect(jevTaskSchema.safeParse({ ...task(), actions }).success).toBe(false);
  expect(jevTaskSchema.safeParse({ ...task(), state: "x".repeat(24001) }).success).toBe(false);
  for (const max_steps of [0, 13, 1.5])
    expect(jevTaskSchema.safeParse({ ...task(), max_steps }).success).toBe(false);
});

test("budget, finish, replan and invalid choices return control without speculative actions", async () => {
  for (const [selection, expected, count] of [
    ["a0", "budget_exhausted", 1], ["finish", "review_required", 0],
    ["replan", "needs_replan", 0], ["invented", "needs_replan", 0],
  ] as const) {
    let actions = 0;
    const result = await runJevTask({ ...task(), max_steps: 1 }, {
      context: context(), assertEnabled: () => {}, decide: async () => choice(selection),
      execute: async () => { actions++; return { ok: true }; },
    });
    expect(result.status).toBe(expected);
    expect(actions).toBe(count);
    expect(result.remaining.length).toBe(2 - count);
  }
});

test("failed tools, API failure and cancellation retain prior results and stop dependent work", async () => {
  for (const failure of [{ ok: false }, { isError: true }, { exit_code: 1 }, { error: "failed" }]) {
    let decisions = 0;
    const result = await runJevTask(task(), {
      context: context(), assertEnabled: () => {},
      decide: async () => { decisions++; return choice(); }, execute: async () => failure,
    });
    expect(result.status).toBe("needs_replan");
    expect(decisions).toBe(1);
    expect(result.observations[0]?.ok).toBe(false);
  }
  let decisions = 0;
  const partial = await runJevTask(task(), {
    context: context(), assertEnabled: () => {},
    decide: async () => { if (decisions++) throw Error("Jev: HTTP 503"); return choice(); },
    execute: async () => ({ content: "Evidence" }),
  });
  expect(partial.observations).toHaveLength(1);
  expect(partial.remaining).toEqual(["report"]);
  expect(partial.usage.total_tokens).toBe(11);
  expect(partial.status).toBe("needs_replan");
  expect(partial.cost).toBeNull();
  const controller = new AbortController();
  let actions = 0;
  const interrupted = await runJevTask(task(), {
    context: { ...context(), signal: controller.signal }, assertEnabled: () => {},
    decide: async () => { controller.abort(); return choice(); },
    execute: async () => { actions++; },
  });
  expect(interrupted.status).toBe("interrupted");
  expect(interrupted.usage.total_tokens).toBe(11);
  expect(actions).toBe(0);
});

test("large observations are bounded and explicitly marked in the next decision and parent result", async () => {
  let decisions = 0;
  const result = await runJevTask(task(), {
    context: context(), assertEnabled: () => {},
    decide: async (input) => {
      if (decisions++) {
        const observations = (input.state as Json).observations as Json[];
        expect(observations[0]?.truncated).toBe(true);
        expect(String(observations[0]?.output).length).toBe(1600);
        return { ...choice("replan"), cost: undefined };
      }
      return choice();
    },
    execute: async () => ({ content: "x".repeat(50000) }),
  });
  expect(result.cost).toBeNull();
  expect(JSON.stringify(result).length).toBeLessThan(35000);
  expect(result.observations[0]?.truncated).toBe(true);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hibana-jev-task-"));
  const runtime = new Runtime(loadConfig({
    HIBANA_DATA_DIR: dir, RUNTIME_STATE_PATH: "", JEV_API_KEY: "fixture", JEV_TASK_ENABLED: "true",
    SUBAGENT_MAX_CONCURRENT: "1", SKILLS_ENABLED: "false",
  }));
  const agent = new Agent(new LlmClient(runtime.config));
  const registry = new ToolRegistry(runtime, new Client({ intents: [] }), agent);
  // File tools use the real workspace jail; no Docker process is needed here.
  registry.sandbox.available = true;
  registry.jev.decide = async () => choice();
  return { runtime, registry, agent, close: async () => { await registry.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("task status edits one notice with 1–2 status lines and omits arguments", async () => {
  const f = await fixture();
  let posts = 0;
  let current = "";
  const statuses: string[] = [];
  const ctx = {
    ...context(),
    notify: async () => { throw new Error("task must edit jevTaskProgress, not notify"); },
    jevTaskProgress: async (text: string) => {
      if (!current) posts++;
      current = text;
      statuses.push(text);
    },
  };
  const first = {
    objective: "Inspect the prepared report and its source",
    state: { secret: "do-not-post" },
    status: "結果を確認しながら次の操作を選び、タスクを進めます。",
    actions: [
      { id: "source", description: "Read the source", tool: "read_file", arguments: { path: "secret-source.txt" } },
      { id: "report", description: "Read the report after its source", tool: "read_file", arguments: { path: "secret-report.txt" }, depends_on: ["source"] },
    ],
  };
  const second = {
    objective: "Read the report once more",
    state: { secret: "still-secret" },
    actions: [
      { id: "again", description: "Read the report", tool: "read_file", arguments: { path: "secret-report.txt" } },
    ],
  };
  try {
    await f.registry.sandbox.write(ctx, "secret-source.txt", "source body");
    await f.registry.sandbox.write(ctx, "secret-report.txt", "report body");
    expect((await f.registry.execute("run_jev_task", first, ctx) as Json).status).toBe("completed_plan");
    expect((await f.registry.execute("run_jev_task", second, ctx) as Json).status).toBe("completed_plan");
    expect(posts).toBe(1);
    expect(current.startsWith(JEV_TASK_NOTICE_HEADER)).toBe(true);
    expect(current.split("\n").length).toBeLessThanOrEqual(3);
    expect(statuses.some((s) => s.includes("次の操作を選んでいます"))).toBe(true);
    expect(statuses.some((s) => s.includes("source（read_file）を実行しています。"))).toBe(true);
    expect(statuses.some((s) => s.includes("候補の実行が終わりました。"))).toBe(true);
    expect(statuses.join("\n")).not.toContain("do-not-post");
    expect(statuses.join("\n")).not.toContain("secret-source.txt");
    expect(statuses.join("\n")).not.toContain("結果を確認しながら");
    expect(formatJevTaskStatus(12, "a", "b", "c").split("\n")).toEqual([
      `${JEV_TASK_NOTICE_HEADER}(12回目)`, "a", "b",
    ]);
  } finally { await f.close(); }
});

test("task tool uses the normal workspace jail and preserves guild and DM isolation", async () => {
  const f = await fixture();
  const ctx = context();
  const plan = {
    objective: "Write and read the prepared report", state: "Use the supplied content",
    actions: [
      { id: "write", description: "Write report", tool: "mcp__workspace__write_file", arguments: { path: "report.txt", content: "Guild 100 report" } },
      { id: "read", description: "Read report", tool: "read_file", arguments: { path: "report.txt" }, depends_on: ["write"] },
    ],
  };
  try {
    expect(f.registry.tools(ctx).some((t) => t.function.name === "mcp__agent__run_jev_task")).toBe(true);
    const result = await f.registry.execute("mcp__agent__run_jev_task", plan, ctx) as Json;
    expect(result.status).toBe("completed_plan");
    expect(JSON.stringify(result.observations)).toContain("Guild 100 report");
    for (const other of [{ ...ctx, guildId: "101" }, { ...ctx, guildId: undefined, channelId: "201" }])
      // Check the actual scoped file, not the direct-tool gate introduced by
      // action mode: a rejection at that gate alone would not prove isolation.
      await expect(f.registry.sandbox.read(other, "report.txt")).rejects.toThrow();
    const escape = await f.registry.execute("run_jev_task", {
      ...plan, actions: [{ ...plan.actions[0], arguments: { path: "../escape.txt", content: "blocked" } }],
    }, ctx) as Json;
    expect(escape.status).toBe("needs_replan");
    expect((escape.observations as Json[])[0]?.ok).toBe(false);
    expect(ctx.delivered).toBe(false);
  } finally { await f.close(); }
});

test("task candidates cannot bypass tool availability, validation, or Jev opt-out", async () => {
  const f = await fixture();
  let decisions = 0, notices = 0;
  const ctx = { ...context(), notify: async () => { notices++; } };
  f.registry.jev.decide = async () => { decisions++; return choice(); };
  try {
    for (const tool of ["run_jev_task", "run_jev", "spawn_agent", "home_vpn_connect", "unknown_tool"])
      await expect(f.registry.execute("run_jev_task", {
        ...task(), actions: [{ ...task().actions[0], tool }],
      }, ctx)).rejects.toThrow("Jev task tool unavailable");
    await expect(f.registry.execute("run_jev_task", {
      ...task(), actions: [{ ...task().actions[0], arguments: {} }],
    }, ctx)).rejects.toThrow("Invalid Jev action arguments");
    f.registry.sandbox.available = false;
    await expect(f.registry.execute("run_jev_task", task(), ctx)).rejects.toThrow("unavailable");
    f.registry.sandbox.available = true;
    for (const c of [{ ...ctx, depth: 1 }, ctx]) {
      if (c.depth === 0) await f.runtime.patch("100", { jev_task_enabled: false }, ctx.userId);
      expect(f.registry.tools(c).some((t) => t.function.name === "mcp__agent__run_jev_task")).toBe(false);
      await expect(f.registry.execute("run_jev_task", task(), c)).rejects.toThrow("Tool disabled");
    }
    expect(decisions).toBe(0);
    expect(notices).toBe(0);
  } finally { await f.close(); }
});

test("disabling during inference prevents the selected action and counts the completed request", async () => {
  const f = await fixture();
  const usage = emptyUsage();
  const ctx = { ...context(), recordToolUsage: (u: typeof usage) => { usage.total_tokens += u.total_tokens; } };
  f.registry.jev.decide = async () => {
    await f.runtime.patch("100", { jev_task_enabled: false }, ctx.userId);
    return choice();
  };
  try {
    const result = await f.registry.execute("run_jev_task", task(), ctx) as Json;
    expect(result.observations).toEqual([]);
    expect(result.reason).toBe("Jev is disabled for this context");
    expect(usage.total_tokens).toBe(11);
  } finally { await f.close(); }
});

test("parent loop forwards steering to Jev and accounts for its usage without changing the planner", async () => {
  const f = await fixture();
  const steering = new AbortController();
  const ctx = context();
  const selection = f.runtime.resolve(ctx.guildId, ctx.userId).selection;
  let completions = 0;
  f.agent.llm.complete = async (selected) => {
    expect(selected).toEqual(selection);
    return {
      message: completions++ ? { role: "assistant" as const, content: "Reviewed the partial results." } : {
        role: "assistant" as const, content: null,
        tool_calls: [{ id: "task", type: "function" as const, function: { name: "mcp__agent__run_jev_task", arguments: JSON.stringify(task()) } }],
      }, usage: { ...emptyUsage(), total_tokens: 100 }, incomplete: false,
    };
  };
  f.registry.jev.decide = async (_input, signal) => {
    expect(signal?.aborted).toBe(false);
    steering.abort();
    expect(signal?.aborted).toBe(true);
    return choice();
  };
  try {
    const result = await f.agent.run({
      selection, messages: [{ role: "user", content: "Inspect my report" }],
      tools: f.registry.tools(ctx), context: ctx, maxRounds: 4, temperature: 0,
      nativeSearch: false, requestSignal: () => steering.signal,
      execute: (name, args, c) => f.registry.execute(name, args, c),
    });
    expect(result.usage.total_tokens).toBe(211);
    const taskResult = JSON.parse(result.messages.find((m) => m.role === "tool")!.content!);
    expect(taskResult.status).toBe("interrupted");
    expect(taskResult.observations).toEqual([]);
  } finally { await f.close(); }
});

test("evaluation and task modes have independent defaults, overrides, credentials and tool surfaces", async () => {
  const f = await fixture();
  const ctx = context();
  const exposed = (name: string, c = ctx) => f.registry.tools(c).some((t) => t.function.name === name);
  try {
    expect(loadConfig({}).jevTaskEnabled).toBe(false);
    await f.runtime.patch("100", { jev_enabled: false, jev_task_enabled: true }, ctx.userId);
    expect(exposed("mcp__agent__run_jev")).toBe(false);
    expect(exposed("mcp__agent__run_jev_task")).toBe(true);
    expect(exposed("shell_command")).toBe(false);
    expect(exposed("apply_patch")).toBe(false);
    const planTool = f.registry.tools(ctx).find((t) => t.function.name === "mcp__agent__run_jev_task")!;
    expect(planTool.function.description).toContain('"name":"bash"');
    expect(planTool.function.description).toContain('"name":"apply_patch"');
    expect(planTool.function.description).toContain('"name":"read_file"');

    await f.runtime.patch("100", { jev_enabled: true, jev_task_enabled: false }, ctx.userId);
    expect(exposed("mcp__agent__run_jev")).toBe(true);
    expect(exposed("mcp__agent__run_jev_task")).toBe(false);
    expect(exposed("shell_command")).toBe(true);
    expect(exposed("apply_patch")).toBe(true);
    await expect(f.registry.execute("run_jev_task", task(), ctx)).rejects.toThrow("Tool disabled");

    f.runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(emptyUserOverride(), { jev_task_enabled: true });
    expect(exposed("mcp__agent__run_jev_task")).toBe(true);
    expect(f.runtime.resolve(undefined, ctx.userId).jev_task_enabled).toBe(true);
    expect(f.runtime.resolve("100", "other").jev_task_enabled).toBe(false);
    expect(f.registry.jevTaskMode({ ...ctx, depth: 1 })).toBe(false);
    expect(exposed("mcp__agent__run_jev_task", { ...ctx, depth: 1 })).toBe(false);
    f.runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(emptyUserOverride(), { jev_task_enabled: false });
    expect(exposed("mcp__agent__run_jev_task")).toBe(false);
    await f.runtime.patch("100", { jev_task_enabled: true }, ctx.userId);
    // An explicit personal OFF stays off when the server turns the mode on.
    expect(exposed("shell_command")).toBe(true);
    f.runtime.snapshot.user_overrides[ctx.userId] = applyUserOverridePatch(emptyUserOverride(), { jev_task_enabled: true });
    f.runtime.config.jevApiKey = "";
    expect(exposed("mcp__agent__run_jev_task")).toBe(false);
    // Missing credentials must not silently fall back to unselected actions.
    expect(exposed("shell_command")).toBe(false);
    f.runtime.config.jevApiKey = "fixture";
    f.runtime.config.subagentEnabled = false;
    expect(exposed("mcp__agent__run_jev_task")).toBe(false);
  } finally { await f.close(); }
});

test("mode ON blocks direct and aliased actions at execution, and OFF restores direct tools", async () => {
  const f = await fixture();
  const ctx = context();
  let decisions = 0;
  f.registry.jev.decide = async () => { decisions++; return choice(); };
  try {
    for (const [name, args] of [
      ["write_file", { path: "bypass.txt", content: "bad" }],
      ["mcp__workspace__write_file", { path: "bypass.txt", content: "bad" }],
      ["Write", { file_path: "bypass.txt", content: "bad" }],
      ["shell_command", { command: "touch bypass.txt" }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: bypass.txt\n+bad\n*** End Patch" }],
      ["use_tool", { tool_name: "write_file", arguments: { path: "bypass.txt", content: "bad" } }],
    ] as const)
      await expect(f.registry.execute(name, args, ctx)).rejects.toThrow("requires run_jev_task");
    await expect(f.registry.sandbox.read(ctx, "bypass.txt")).rejects.toThrow();
    expect(decisions).toBe(0);
    await f.runtime.patch("100", { jev_task_enabled: false }, ctx.userId);
    await f.registry.execute("write_file", { path: "direct.txt", content: "direct" }, ctx);
    expect((await f.registry.sandbox.read(ctx, "direct.txt")).content).toBe("direct");
    expect(decisions).toBe(0);
  } finally { await f.close(); }
});

test("standard planner loop executes several Jev actions per plan, replans from observations and returns the final answer", async () => {
  const f = await fixture();
  const ctx = context();
  let completions = 0, decisions = 0;
  const events: string[] = [];
  const selection = f.runtime.resolve(ctx.guildId, ctx.userId).selection;
  await f.runtime.patch("100", { jev_enabled: false }, ctx.userId);
  const first = {
    objective: "Create and inspect a report", state: "Write hello, then inspect it",
    actions: [
      { id: "write", description: "Write report", tool: "write_file", arguments: { path: "report.txt", content: "hello" } },
      { id: "read", description: "Inspect report", tool: "read_file", arguments: { path: "report.txt" }, depends_on: ["write"] },
      { id: "list", description: "Inspect output files", tool: "list_files", arguments: {}, depends_on: ["read"] },
    ],
  };
  const second = {
    objective: "Apply the final addition and verify it", state: "Prior observations confirm report.txt contains hello",
    actions: [
      { id: "edit", description: "Add world", tool: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Update File: report.txt\n@@\n-hello\n+hello world\n*** End Patch" } },
      { id: "verify", description: "Verify report", tool: "read_file", arguments: { path: "report.txt" }, depends_on: ["edit"] },
    ],
  };
  f.registry.jev.decide = async (input) => {
    decisions++;
    events.push("jev");
    const s = input.state as Json;
    const actions = s.available_actions as Json[];
    if (actions[0]?.id === "read") expect(JSON.stringify(s.observations)).toContain('write');
    if (actions[0]?.id === "list") expect(JSON.stringify(s.observations)).toContain('hello');
    return choice();
  };
  f.agent.llm.complete = async (selected, messages, tools, options) => {
    expect(selected).toEqual(selection);
    expect(options?.nativeSearch).toBe(false);
    expect(tools.some((t) => t.function.name === "shell_command")).toBe(false);
    expect(tools.some((t) => t.function.name === "apply_patch")).toBe(false);
    expect(tools.some((t) => t.function.name === "mcp__agent__run_jev")).toBe(false);
    expect(tools.some((t) => t.function.name === "mcp__agent__run_jev_task")).toBe(true);
    expect(messages.some((m) => m.content?.includes("Jev action-selection mode is ON"))).toBe(true);
    events.push("parent");
    const i = completions++;
    if (i === 1) {
      const previous = JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content!);
      expect(previous.observations).toHaveLength(3);
      expect(previous.status).toBe("completed_plan");
    }
    return {
      message: i === 2 ? { role: "assistant" as const, content: "The report is complete." } : {
        role: "assistant" as const, content: null,
        tool_calls: [{ id: `plan${i}`, type: "function" as const, function: {
          name: "mcp__agent__run_jev_task", arguments: JSON.stringify(i === 0 ? first : second),
        } }],
      }, usage: { ...emptyUsage(), total_tokens: 100 }, incomplete: false,
    };
  };
  try {
    const result = await f.agent.run({
      selection, messages: [{ role: "user", content: "Create the report" }],
      tools: f.registry.tools(ctx), getTools: (c) => f.registry.tools(c), jevTaskMode: (c) => f.registry.jevTaskMode(c),
      context: ctx, maxRounds: 10, temperature: 0, nativeSearch: true,
      execute: (name, args, c) => f.registry.execute(name, args, c),
    });
    expect(events).toEqual(["parent", "jev", "jev", "jev", "parent", "jev", "jev", "parent"]);
    expect(decisions).toBe(5);
    expect(result.usage.total_tokens).toBe(355);
    expect((await f.registry.sandbox.read(ctx, "report.txt")).content.trim()).toBe("hello world");
  } finally { await f.close(); }
});

test("live mode changes refresh tools and search at the next parent boundary", async () => {
  const f = await fixture();
  const ctx = context();
  let completions = 0;
  f.registry.jev.decide = async () => {
    await f.runtime.patch("100", { jev_task_enabled: false }, ctx.userId);
    return choice();
  };
  f.agent.llm.complete = async (_selection, messages, tools, options) => {
    const i = completions++;
    expect(options?.nativeSearch).toBe(i > 0);
    expect(tools.some((t) => t.function.name === "shell_command")).toBe(i > 0);
    expect(tools.some((t) => t.function.name === "mcp__agent__run_jev_task")).toBe(i === 0);
    if (i) expect([...messages].reverse().find((m) => m.role === "developer")?.content).toContain("mode is OFF");
    return {
      message: i ? { role: "assistant" as const, content: "Mode changed; no operation was executed." } : {
        role: "assistant" as const, content: null,
        tool_calls: [{ id: "plan", type: "function" as const, function: { name: "mcp__agent__run_jev_task", arguments: JSON.stringify(task()) } }],
      }, usage: emptyUsage(), incomplete: false,
    };
  };
  try {
    const result = await f.agent.run({
      selection: f.runtime.resolve(ctx.guildId, ctx.userId).selection,
      messages: [{ role: "user", content: "Inspect the report" }],
      tools: f.registry.tools(ctx), getTools: (c) => f.registry.tools(c), jevTaskMode: (c) => f.registry.jevTaskMode(c),
      context: ctx, maxRounds: 4, temperature: 0, nativeSearch: true,
      execute: (name, args, c) => f.registry.execute(name, args, c),
    });
    expect(result.text).toContain("Mode changed");
    expect(JSON.parse(result.messages.find((m) => m.role === "tool")!.content!).observations).toEqual([]);
  } finally { await f.close(); }
});

test("selected write_files preserves overwrite restrictions and uses one decision for the prepared batch", async () => {
  const f = await fixture();
  const ctx = context();
  let decisions = 0;
  f.registry.jev.decide = async () => { decisions++; return choice(); };
  const input = {
    objective: "Write the prepared files", state: "Do not overwrite existing files",
    actions: [{ id: "write", description: "Write two files", tool: "write_files", arguments: {
      files: [{ path: "a.txt", content: "a" }, { path: "b.txt", content: "b" }], overwrite: false,
    } }],
  };
  try {
    expect((await f.registry.execute("run_jev_task", input, ctx) as Json).status).toBe("completed_plan");
    expect(decisions).toBe(1);
    const again = await f.registry.execute("run_jev_task", input, ctx) as Json;
    expect(again.status).toBe("needs_replan");
    expect(JSON.stringify(again.observations)).toContain("File exists");
    expect((await f.registry.sandbox.read(ctx, "a.txt")).content).toBe("a");
  } finally { await f.close(); }
});

test("Jev candidates inherit parent integrations and recheck settings before execution", async () => {
  const f = await fixture();
  const ctx = context();
  const description = () => f.registry.tools(ctx).find((t) => t.function.name === "mcp__agent__run_jev_task")!.function.description;
  try {
    for (const name of ["playwright_cli", "view_image"])
      expect(description()).toContain(`"name":"${name}"`);
    // Direct integrations retain their schemas once, outside the plan tool.
    for (const name of ["send_file", "set_bot_model", "mcp_call_tool"]) {
      expect(f.registry.tools(ctx).some(t => t.function.name.endsWith(`__${name}`))).toBe(true);
      expect(description()).not.toContain(`"name":"${name}"`);
    }
    let calls = 0;
    f.registry.web.remote = async (name, args, c) => {
      expect(name).toBe("mcp_call_tool");
      expect(args).toEqual({ name: "fixture_tool", arguments: { value: 42 } });
      expect(c.guildId).toBe(ctx.guildId);
      expect(c.userId).toBe(ctx.userId);
      calls++;
      return { content: [] };
    };
    const plan = { objective: "Use the authorized integration", state: "User authorized this action", actions: [
      { id: "remote", description: "Call integration", tool: "mcp_call_tool", arguments: { name: "fixture_tool", arguments: { value: 42 } } },
    ] };
    expect((await f.registry.execute("run_jev_task", plan, ctx) as Json).status).toBe("completed_plan");
    expect(calls).toBe(1);
    f.registry.jev.decide = async () => {
      await f.runtime.patch("100", { mcp_enabled: false }, ctx.userId);
      return choice();
    };
    expect((await f.registry.execute("run_jev_task", plan, ctx) as Json).status).toBe("needs_replan");
    expect(calls).toBe(1);
    expect(description()).not.toContain('"name":"mcp_call_tool"');
    await expect(f.registry.execute("run_jev_task", plan, ctx)).rejects.toThrow("unavailable");
  } finally { await f.close(); }
});

test("browser screenshots reach the parent before dependent actions and delivery state survives context copies", async () => {
  const f = await fixture();
  const ctx = context();
  const commands: unknown[] = [];
  let completions = 0;
  const image = "data:image/png;base64,iVBORw0KGgo=";
  f.registry.media.browserCommand = async (c, args) => {
    commands.push(args.args);
    expect(c.channelId).toBe(ctx.channelId);
    expect(c.userId).toBe(ctx.userId);
    return { exit_code: 0, stdout: "screen.png", stderr: "", truncated: false };
  };
  // Simulate the external delivery boundary without sending a Discord message.
  f.registry.web.remote = async (_name, _args, c) => {
    c.delivered = true;
    return { content: [] };
  };
  const plan = { objective: "Play and inspect the game", state: "User requested browser play", actions: [
    { id: "open", description: "Open game", tool: "mcp__workspace__playwright_cli", arguments: { args: ["open", "https://example.com/game"] } },
    { id: "play", description: "Press game control", tool: "playwright_cli", arguments: { args: ["press", "ArrowRight"] }, depends_on: ["open"] },
    { id: "shot", description: "Capture screen", tool: "playwright_cli", arguments: { args: ["screenshot"] }, depends_on: ["play"] },
    { id: "inspect", description: "Inspect screen", tool: "view_image", arguments: { path: "screen.png" }, depends_on: ["shot"] },
    { id: "close", description: "Close browser", tool: "playwright_cli", arguments: { args: ["close"] }, depends_on: ["inspect"] },
  ] };
  f.agent.llm.complete = async (_selection, messages) => {
    const i = completions++;
    if (i === 1) {
      expect(messages.find((m) => m.images?.includes(image))).toBeDefined();
      const result = JSON.parse(messages.find((m) => m.role === "tool")!.content!);
      expect(result.status).toBe("needs_replan");
      expect(result.remaining).toEqual(["close"]);
      expect(commands).toHaveLength(3);
    }
    return { message: i === 2 ? { role: "assistant" as const, content: "Reviewed the screen." } : {
      role: "assistant" as const, content: null,
      tool_calls: [{ id: `plan${i}`, type: "function" as const, function: { name: "mcp__agent__run_jev_task", arguments: JSON.stringify(i === 0 ? plan : {
        objective: "Close and deliver", state: "Screen reviewed", actions: [
          { ...plan.actions[4], depends_on: [] },
          { id: "deliver", description: "Deliver result", tool: "mcp_call_tool", arguments: { name: "deliver", arguments: {} }, depends_on: ["close"] },
        ],
      }) } }],
    }, usage: emptyUsage(), incomplete: false };
  };
  try {
    await Bun.write(await f.registry.sandbox.path(ctx, "screen.png"), Buffer.from("iVBORw0KGgo=", "base64"));
    for (const name of ["playwright_cli", "mcp__workspace__playwright_cli", "view_image"])
      await expect(f.registry.execute(name, {}, ctx)).rejects.toThrow("requires run_jev_task");
    await f.agent.run({
      selection: f.runtime.resolve(ctx.guildId, ctx.userId).selection,
      messages: [{ role: "user", content: "Play the game and capture evidence" }],
      tools: f.registry.tools(ctx), context: ctx, maxRounds: 5, temperature: 0, nativeSearch: false,
      execute: (name, args, c) => f.registry.execute(name, args, c),
    });
    expect(completions).toBe(3);
    expect(commands.at(-1)).toEqual(["close"]);
    expect(ctx.delivered).toBe(true);
    expect(ctx.pendingImages).toEqual([]);
    // Replanning after visual review must continue the same notice counter.
    expect(ctx.jevExecutions?.count).toBe(14);
  } finally { await f.close(); }
});

test("Discord candidates preserve delivery while collaboration bypasses Jev selection", async () => {
  const f = await fixture();
  const calls: string[] = [];
  const ctx: Context = { ...context(), team: {
    execute: async (name: string) => { calls.push(`agent:${name}`); return { ok: true }; },
  } as unknown as Context["team"] };
  f.registry.discord.execute = async (name, args) => {
    expect(args.content).toBe("Authorized message");
    calls.push(`discord:${name}`);
    return { ok: true };
  };
  try {
    const tools = f.registry.tools(ctx);
    expect(tools.some((t) => t.function.name === "mcp__discord__send_message")).toBe(true);
    expect(tools.some((t) => t.function.name === "agents__send_message")).toBe(true);
    const plan = {
      objective: "Send authorized messages", state: "Both messages explicitly authorized",
      actions: [
        { id: "discord", description: "Post message", tool: "mcp__discord__send_message", arguments: { content: "Authorized message" } },
      ],
    };
    await expect(f.registry.execute("run_jev_task", { ...plan, actions: [...plan.actions,
      { id: "agent", description: "Steer worker", tool: "agents__send_message", arguments: { target: "worker", message: "Continue" } },
    ] }, ctx)).rejects.toThrow("Jev task tool unavailable: agents__send_message");
    expect(calls).toEqual([]);
    const result = await f.registry.execute("run_jev_task", plan, ctx) as Json;
    expect(result.status).toBe("completed_plan");
    await f.registry.execute("agents__send_message", { target: "worker", message: "Continue" }, ctx);
    expect(calls).toEqual(["discord:send_message", "agent:send_message"]);
  } finally { await f.close(); }
});

test("home connection ownership survives Jev replans but never transfers to another turn", async () => {
  const { HomeSession } = await import("../tools/home");
  const ctx = context();
  const home = new HomeSession(loadConfig({}), async () => ({
    enabled: true, connected: 1, idle: 0, waiting: 0, idle_timeout_secs: 900, expires_in_secs: 900,
  }));
  await home.connect(ctx);
  for (let plan = 0; plan < 2; plan++) {
    const result = await runJevTask({ ...task(), max_steps: 1 }, {
      context: ctx, assertEnabled: () => {}, decide: async () => choice(),
      execute: async (_name, _args, scoped) => {
        expect(home.owns(scoped)).toBe(true);
        expect(home.route(scoped)).toBeDefined();
        expect(home.owns(context())).toBe(false);
        expect(home.route(context())).toBeUndefined();
        return { ok: true };
      },
    });
    expect(result.status).toBe("budget_exhausted");
  }
  expect(home.owns(ctx)).toBe(true);
  await home.disconnect();
  expect(home.active).toBe(false);
});

test("Jev pipelines individually selected searches and waits for dependencies through the real registry", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  let decisions = 0;
  f.registry.jev.decide = async (input) => {
    const state = input.state as Json;
    if (++decisions === 2) {
      expect(state.in_flight_actions).toEqual(["a"]);
      expect(state.observations).toHaveLength(0);
    }
    if (decisions === 3) expect(state.observations).toHaveLength(2);
    return choice();
  };
  f.registry.web.search = async (_name, args) => {
    events.push(`start:${args.query}`);
    if (args.query === "a") await release.promise;
    if (args.query === "b") release.resolve();
    events.push(`end:${args.query}`);
    return { content: args.query };
  };
  try {
    const result = await f.registry.execute("run_jev_task", {
      objective: "Research two independent sources and their follow-up", state: "Both initial searches are independent",
      actions: [
        { id: "a", description: "First search", tool: "web_search", arguments: { query: "a" }, parallel: true },
        { id: "b", description: "Second search", tool: "mcp__web__websearch", arguments: { query: "b" }, parallel: true },
        { id: "c", description: "Follow-up after both", tool: "websearch", arguments: { query: "c" }, depends_on: ["a", "b"], parallel: true },
      ],
    }, context()) as Json;
    expect(result.status).toBe("completed_plan");
    expect(events.indexOf("start:b")).toBeLessThan(events.indexOf("end:a"));
    expect(events.indexOf("start:c")).toBeGreaterThan(events.indexOf("end:a"));
    expect(result.observations).toHaveLength(3);
    expect(decisions).toBe(3);
  } finally { release.resolve(); await f.close(); }
});

test("Jev parallel read failures retain siblings and prevent a mutation even when it opts into parallelism", async () => {
  for (const fail of [false, true]) {
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const plan = jevTaskSchema.parse({
      objective: "Gather evidence then write", state: "Authorized plan",
      actions: [
        { id: "a", description: "First source", tool: "websearch", arguments: { query: "a" }, parallel: true },
        { id: "b", description: "Second source", tool: "websearch", arguments: { query: "b" }, parallel: true },
        { id: "write", description: "Write after observations", tool: "bash", arguments: { command: "write" }, parallel: true },
      ],
    });
    const result = await runJevTask(plan, {
      context: context(), assertEnabled: () => {}, decide: async () => choice(),
      execute: async (name, args) => {
        if (args.query === "a") { await release.promise; events.push("a"); return { ok: !fail }; }
        if (args.query === "b") { events.push("b"); release.resolve(); return { ok: true }; }
        expect(name).toBe("bash");
        expect(events.sort()).toEqual(["a", "b"]);
        events.push("write");
        return { ok: true };
      },
    });
    expect(result.status).toBe(fail ? "needs_replan" : "completed_plan");
    expect(result.observations).toHaveLength(fail ? 2 : 3);
    expect(events.includes("write")).toBe(!fail);
  }
});

test("Jev limits in-flight reads and cancellation drains observations without dependent execution", async () => {
  const release = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const plan = jevTaskSchema.parse({ objective: "Independent reads", state: "All useful", actions:
    Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, description: "Read", tool: "read_file", arguments: { path: `${i}` }, parallel: true })),
  });
  const result = await runJevTask(plan, {
    context: context(), assertEnabled: () => {}, decide: async () => choice(),
    execute: async () => {
      peak = Math.max(peak, ++active);
      if (active === 6) release.resolve();
      await release.promise;
      active--;
      return { content: "Evidence" };
    },
  });
  expect(peak).toBe(6);
  expect(result.observations).toHaveLength(12);
  expect(result.status).toBe("completed_plan");

  const controller = new AbortController();
  let decisions = 0, started = 0;
  const interrupted = await runJevTask(plan, {
    context: { ...context(), signal: controller.signal }, assertEnabled: () => {},
    decide: async () => { if (++decisions === 2) controller.abort(new Error("New request")); return choice(); },
    execute: async (_name, _args, ctx) => {
      started++;
      await new Promise<void>((_resolve, reject) => ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }));
    },
  });
  expect(interrupted.status).toBe("interrupted");
  expect(started).toBe(1);
  expect(interrupted.observations).toHaveLength(1);
});

test("image Read candidates return for parent review before dependent actions", async () => {
  const plan = jevTaskSchema.parse({ objective: "Inspect the screenshot", state: "Screenshot exists", actions: [
    { id: "image", description: "Inspect pixels", tool: "Read", arguments: { file_path: "screen.png" }, parallel: true },
    { id: "follow", description: "Follow-up", tool: "websearch", arguments: { query: "follow-up" }, depends_on: ["image"] },
  ] });
  let executed = 0;
  const result = await runJevTask(plan, {
    context: context(), assertEnabled: () => {}, decide: async () => choice(),
    execute: async () => { executed++; return { ok: true, image_attached: true }; },
  });
  expect(executed).toBe(1);
  expect(result.status).toBe("needs_replan");
  expect(result.remaining).toEqual(["follow"]);
});
