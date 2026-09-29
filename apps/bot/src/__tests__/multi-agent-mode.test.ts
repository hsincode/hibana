import { expect, test } from "bun:test";
import { Client } from "discord.js";
import pino from "pino";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import {
  emptyGuild,
  emptyUserOverride,
  SUBAGENT_MODES,
  subagentModePatch,
} from "@hibana/shared/settings";
import { Agent, type AgentOptions } from "../agent";
import { roleEffort } from "../agent-roles";
import { loadConfig } from "../config";
import { assemblePrompt, multiAgentModeMessage } from "../harness";
import { triageHint, triageInput } from "../jev-triage";
import { LlmClient } from "../llm";
import { MultiAgentSession } from "../multi-agent";
import { selectChild } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { emptyUsage, type Context, type Json, type Message } from "../types";

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    PROVIDER: "codex_plus",
    LLM_MODEL: "gpt-6.1-sol",
    LLM_EFFORT: "max",
    CODEX_PLUS_API_KEY: "plus-fixture",
    CODEX_PRO_API_KEY: "pro-fixture",
    JEV_API_KEY: "jev-fixture",
    SANDBOX_ENABLED: "false",
    SKILLS_ENABLED: "false",
    RUNTIME_STATE_PATH: "",
    ...env,
  });
const context = (): Context => ({
  guildId: "g1", channelId: "c1", userId: "u1", botId: "bot", thread: false, depth: 0, delivered: false,
});
const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cached_tokens: 0 };
const triageDecision = (p: Record<string, number>) => ({
  model: "~typesafe/jev-latest",
  answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "noul" as const, noul: v }])),
  usage,
  cost: 0,
});
const options = (ctx: Context, runtime: Runtime, messages: Message[]): AgentOptions => ({
  context: ctx, selection: runtime.config.selection, messages, tools: [], maxRounds: 20,
  temperature: 0, nativeSearch: false,
  execute: (name, args, c) => c.team!.execute(name.replace(/^agents__/, ""), args, c),
});

test("every catalog model keeps the four subagent modes and both Jev switches independent", async () => {
  const runtime = new Runtime(config());
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  registry.sandbox.available = true;
  const ctx = { ...context(), team: {} as Context["team"] };
  runtime.snapshot.user_roles[ctx.userId] = "administrator";
  try {
    for (const preset of MODEL_PRESETS)
      for (const mode of SUBAGENT_MODES) for (const evaluation of [false, true]) for (const actions of [false, true]) {
        runtime.snapshot.user_overrides[ctx.userId] = {
          ...emptyUserOverride(),
          selection: { provider: preset.provider, model: preset.model, effort: "low" },
          effort: "low",
          ...subagentModePatch(mode),
          jev_enabled: evaluation,
          jev_task_enabled: actions,
        };
        const prompt = await assemblePrompt(runtime, ctx, "");
        const tools = registry.tools(ctx);
        const names = tools.map((t) => t.function.name);
        const modeMessage = prompt.find((m) => m.content?.startsWith("<multi_agent_mode>"))!;
        // Multi keeps the proactive HsinCLI text byte-for-byte and adds a
        // separate scope; Ultra (Ultracode) keeps the explicit one.
        if (mode === "off") expect(modeMessage.content).toContain("Subagents are disabled");
        else expect(modeMessage).toEqual(multiAgentModeMessage(mode === "multi"));
        // Workflow follows Claude Code's opt-in rule in on/Ultra; Multi-Agent
        // offers it only on turns where the user typed "ultracode".
        expect(names.includes("Workflow")).toBe(mode === "on" || mode === "ultra");
        expect(registry.tools({ ...ctx, workflowKeyword: true }).some((t) => t.function.name === "Workflow")).toBe(mode !== "off");
        expect(prompt.some((m) => m.content?.startsWith("<multi_agent_team>"))).toBe(mode === "multi");
        // The final-message contract fixes "補足だよ" answers in every mode.
        expect(prompt[0]!.content).toContain("The user keeps only your final message");
        expect(prompt.some((m) => m.content?.startsWith("Jev evaluation is enabled"))).toBe(evaluation);
        const taskMode = actions && mode !== "multi";
        expect(registry.jevTaskMode(ctx)).toBe(taskMode);
        expect(names.includes("mcp__agent__run_jev_task")).toBe(taskMode);
        expect(names.includes("mcp__agent__run_jev")).toBe(evaluation);
        expect(names.includes("shell_command")).toBe(!taskMode);
        const spawn = tools.find((t) => t.function.name === "agents__spawn_agent");
        expect(Boolean(spawn)).toBe(mode !== "off");
        if (spawn) {
          const parameters = spawn.function.parameters as { properties: Json; required: string[] };
          expect("role" in parameters.properties).toBe(mode === "multi");
          expect(parameters.required.includes("role")).toBe(mode === "multi");
        }
      }
  } finally { await registry.close(); client.destroy(); }
});

test("role tool surfaces are enforced in the list and at execution, including use_tool", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  registry.sandbox.available = true;
  const child = (agentRole?: string): Context => ({ ...context(), depth: 1, team: {} as Context["team"], agentRole });
  const names = (c: Context) => registry.tools(c).map((t) => t.function.name);
  try {
    const explorer = names(child("explorer"));
    expect(explorer).toEqual(expect.arrayContaining(["mcp__workspace__read_file", "mcp__workspace__grep_files", "view_image", "agents__send_message", "agents__wait_agent"]));
    for (const hidden of ["shell_command", "apply_patch", "mcp__workspace__write_file", "mcp__workspace__send_file", "request_user_input", "agents__spawn_agent", "agents__followup_task"])
      expect(explorer).not.toContain(hidden);

    const worker = names(child("worker"));
    expect(worker).toEqual(expect.arrayContaining(["shell_command", "apply_patch", "agents__send_message"]));
    for (const hidden of ["mcp__workspace__send_file", "mcp__discord__send_message", "mcp__sites__publish_site", "request_user_input", "agents__spawn_agent", "agents__interrupt_agent"])
      expect(worker).not.toContain(hidden);

    const reviewer = names(child("reviewer"));
    expect(reviewer).toContain("shell_command");
    expect(reviewer).not.toContain("apply_patch");
    // An on/Ultra child (no role) keeps the full HsinCLI surface.
    expect(names(child())).toEqual(expect.arrayContaining(["apply_patch", "mcp__workspace__send_file", "agents__spawn_agent"]));

    await expect(registry.execute("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }, child("explorer")))
      .rejects.toThrow("explorer role cannot use apply_patch");
    await expect(registry.execute("shell_command", { command: "ls" }, child("explorer")))
      .rejects.toThrow("explorer role cannot use bash");
    await expect(registry.execute("use_tool", { tool_name: "send_file", arguments: { path: "a.txt" } }, child("worker")))
      .rejects.toThrow("worker role cannot use send_file");
    await expect(registry.execute("agents__spawn_agent", { task_name: "x", message: "m", notice: "調べます", role: "worker" }, child("worker")))
      .rejects.toThrow("worker role cannot use agents__spawn_agent");
  } finally { await registry.close(); client.destroy(); }
});

test("role effort caps only inherited effort and never overrides user policies or explicit requests", () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  const ctx = context();
  const parent = { provider: "codex_plus", model: "gpt-6.1-sol", effort: "max" };
  expect(selectChild(runtime, ctx, parent, {}, "explorer").effort).toBe("medium");
  expect(selectChild(runtime, ctx, { ...parent, effort: "low" }, {}, "explorer").effort).toBe("low");
  expect(selectChild(runtime, ctx, parent, {}, "worker").effort).toBe("max");
  expect(selectChild(runtime, ctx, parent, {}, "reviewer").effort).toBe("max");
  expect(selectChild(runtime, ctx, parent, { reasoning_effort: "high" }, "explorer").effort).toBe("high");
  // A model change starts from the new model's recommendation, then the cap.
  expect(selectChild(runtime, ctx, parent, { model: "plus-luna" }, "explorer")).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "medium" });
  expect(roleEffort("explorer", "default")).toBe("default");
  expect(roleEffort("explorer", undefined)).toBeUndefined();
  runtime.snapshot.guilds.g1 = { ...emptyGuild(), ...subagentModePatch("multi"), subagent_effort: { mode: "same" } };
  expect(selectChild(runtime, ctx, parent, {}, "explorer").effort).toBe("max");
  runtime.snapshot.guilds.g1 = { ...emptyGuild(), ...subagentModePatch("multi"), subagent_effort: { mode: "fixed", effort: "high" } };
  expect(selectChild(runtime, ctx, parent, {}, "explorer").effort).toBe("high");
});

test("Multi-Agent requires roles, keeps spawning with the orchestrator and isolates root-only instructions", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  const ctx = context();
  const notices: string[] = [];
  ctx.notify = async (text) => { notices.push(text); };
  const childSeen = Promise.withResolvers<{ context: Context; messages: Message[] }>();
  const agent = {
    run: async (o: AgentOptions) => {
      o.observeMessages?.(o.messages);
      const c = o.context;
      if (c.agentPath !== "/root") {
        childSeen.resolve({ context: c, messages: o.messages });
        await expect(c.team!.execute("spawn_agent", { task_name: "nested", message: "m", notice: "細部を調べます", role: "explorer" }, c))
          .rejects.toThrow("only the orchestrator");
        return { text: "evidence", messages: o.messages, usage: emptyUsage(), rounds: 1 };
      }
      const invoke = (name: string, a: Json) => c.team!.execute(name, a, c);
      await expect(invoke("spawn_agent", { task_name: "plain", message: "m", notice: "調べます" })).rejects.toThrow("role must be");
      await invoke("spawn_agent", { task_name: "research", message: "Find sources", notice: "出典を集めます", role: "explorer" });
      const listing = await invoke("list_agents", {}) as { agents: { task_name: string; role: string | null }[] };
      expect(listing.agents.find((a) => a.task_name === "/root/research")!.role).toBe("explorer");
      await o.beforeFinal!();
      return { text: "done", messages: o.messages, usage: emptyUsage(), rounds: 1 };
    },
  } as Agent;
  const messages = [...(await assemblePrompt(runtime, ctx, "")), { role: "user" as const, content: "調べて", turnStart: true }];
  expect(messages.some((m) => m.content?.startsWith("<multi_agent_team>"))).toBe(true);
  const result = await new MultiAgentSession(runtime, agent, () => []).runRoot(options(ctx, runtime, messages));
  expect(result.text).toBe("done");
  const seen = await childSeen.promise;
  expect(seen.context.agentRole).toBe("explorer");
  expect(seen.context.agentSelection!.effort).toBe("medium");
  expect(seen.messages.some((m) => m.content?.startsWith("<multi_agent_team>"))).toBe(false);
  const roles = seen.messages.filter((m) => m.content?.startsWith("<multi_agent_role>"));
  expect(roles).toHaveLength(1);
  expect(roles[0]!.content).toContain("You are /root/research");
  expect(roles[0]!.content).toContain("Role: explorer");
  expect(roles[0]!.content).not.toContain("Use agents__spawn_agent");
  expect(notices).toEqual(["サブエージェント（調査）: GPT 6.1 Sol\n出典を集めます"]);
  expect(ctx.agentRole).toBeUndefined();
});

test("Ultra ignores a stray role so its children keep every tool", async () => {
  const runtime = new Runtime(config({ ULTRA_MODE: "true" }));
  const ctx = context();
  let childRole: string | undefined = "unset";
  const agent = {
    run: async (o: AgentOptions) => {
      const c = o.context;
      if (c.agentPath !== "/root") {
        childRole = c.agentRole;
        return { text: "ok", messages: o.messages, usage: emptyUsage(), rounds: 1 };
      }
      await c.team!.execute("spawn_agent", { task_name: "w", message: "m", notice: "作業します", role: "explorer" }, c);
      await o.beforeFinal!();
      return { text: "done", messages: o.messages, usage: emptyUsage(), rounds: 1 };
    },
  } as Agent;
  await new MultiAgentSession(runtime, agent, () => []).runRoot(options(ctx, runtime, [{ role: "user", content: "go", turnStart: true }]));
  expect(childRole).toBeUndefined();
});

async function triageRun(env: NodeJS.ProcessEnv, decide: ToolRegistry["jev"]["decide"], withTriage = true) {
  const runtime = new Runtime(config({ MULTI_AGENT: "true", ...env }));
  const client = new Client({ intents: [] });
  const records: Json[] = [];
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)),
    pino({ level: "info" }, { write: (line) => { records.push(JSON.parse(line)); } }));
  registry.jev.decide = decide;
  const ctx = context();
  const notices: string[] = [];
  ctx.notify = async (text) => { notices.push(text); };
  let rootMessages: Message[] = [];
  const children: Context[] = [];
  const agent = {
    run: async (o: AgentOptions) => {
      if (o.context.agentPath !== "/root") {
        children.push(o.context);
        return { text: "evidence", messages: o.messages, usage: emptyUsage(), rounds: 1 };
      }
      rootMessages = o.messages;
      await o.beforeFinal!();
      return { text: "done", messages: o.messages, usage: emptyUsage(), rounds: 1 };
    },
  } as Agent;
  const session = new MultiAgentSession(runtime, agent, () => [],
    withTriage ? { triage: (c, m) => registry.triage(c, m) } : {});
  try {
    const result = await session.runRoot(options(ctx, runtime, [
      { role: "user", content: "最新の Bun のリリース内容を調べてまとめて", turnStart: true },
    ]));
    const hint = rootMessages.find((m) => m.content?.startsWith("<multi_agent_triage>"))?.content;
    return { result, hint, notices, children, records };
  } finally { await registry.close(); client.destroy(); }
}

test("Jev triage pre-starts an explorer beside the orchestrator and charges its usage", async () => {
  let input: Json | undefined;
  // The production article-explanation scores: research alone now decides,
  // with no team-size question left to argue against delegation.
  const run = await triageRun({}, async (i) => {
    input = i as Json;
    return triageDecision({ needs_research: 0.93, needs_artifact_work: 0.07, needs_review: 0.51 });
  });
  expect((input!.state as Json).latest_user_request).toContain("最新の Bun");
  expect(Object.keys(input!.questions as Json).sort()).toEqual(["needs_artifact_work", "needs_research", "needs_review"]);
  expect(run.children.map((c) => [c.agentPath, c.agentRole])).toEqual([["/root/explorer", "explorer"]]);
  expect(run.notices).toEqual(["サブエージェント（調査）: GPT 6.1 Sol\n依頼に必要な情報を先に調べます。"]);
  expect(run.hint).toContain("/root/explorer (explorer) was already started");
  expect(run.hint).toContain("Spawn more explorers only for distinct sub-questions");
  expect(run.hint).toContain("the runtime will have a reviewer check your candidate final answer");
  expect(run.hint).not.toMatch(/direct answer|without spawning/i);
  expect(run.result.usage.total_tokens).toBe(5);
  const log = run.records.find((r) => r.msg === "Jev triage finished")!;
  expect(log).toMatchObject({ verdict: "classified", needs_research: 0.93, prestart_explorer: true });
  // Never log the request text.
  expect(JSON.stringify(run.records)).not.toContain("最新の Bun");
});

test("negative, failing, disabled and resumed triage never pre-start work", async () => {
  const negative = await triageRun({}, async () =>
    triageDecision({ needs_research: 0.1, needs_artifact_work: 0.1, needs_review: 0.1 }));
  expect(negative.children).toEqual([]);
  // Nothing to research or build: the hint points at a direct single-pass reply.
  expect(negative.hint).toContain("answer directly in one pass");

  const failing = await triageRun({}, async () => { throw new Error("Jev: HTTP 503"); });
  expect(failing.children).toEqual([]);
  expect(failing.hint).toBeUndefined();
  expect(failing.records.find((r) => r.msg === "Jev triage finished")!.verdict).toBe("unavailable");

  let calls = 0;
  const count = async () => { calls++; return triageDecision({ needs_research: 1, needs_artifact_work: 1, needs_review: 1 }); };
  for (const run of [
    await triageRun({ JEV_ENABLED: "false" }, count),
    await triageRun({ MULTI_AGENT: "false", ULTRA_MODE: "true" }, count),
    await triageRun({}, count, false),
  ]) {
    expect(run.children).toEqual([]);
    expect(run.hint).toBeUndefined();
  }
  expect(calls).toBe(0);
});

test("triage input carries only visible conversation and hints stay advisory", () => {
  const input = triageInput([
    { role: "system", content: "PRIVATE SYSTEM" },
    { role: "user", content: "# AGENTS.md instructions\nPRIVATE RULES" },
    { role: "user", content: "前の質問", turnStart: true },
    { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t", content: "PRIVATE TOOL OUTPUT" },
    { role: "assistant", content: "前の回答" },
    { role: "user", content: "internal", internal: true },
    { role: "user", content: "x".repeat(5000), images: ["a.png"], turnStart: true },
  ]);
  expect(input.state.latest_user_request).toHaveLength(4000);
  expect(input.state.attached_images).toBe(1);
  expect(input.state.prior_conversation).toEqual([
    { role: "user", text: "前の質問" }, { role: "assistant", text: "前の回答" },
  ]);
  expect(JSON.stringify(input)).not.toContain("PRIVATE");
  const hint = triageHint({ needs_research: 0.2, needs_artifact_work: 0.8, needs_review: 0.6 });
  expect(hint).toContain("fallible");
  expect(hint).toContain("Roles likely useful: worker.");
  expect(hint).toContain("the runtime will have a reviewer");
  expect(hint).not.toContain("already started");
});

test("real agent loop: role workers run in parallel, only root delivers, and a failed review forces a full rewrite", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true", JEV_ENABLED: "false" }));
  const llm = new LlmClient(runtime.config);
  const seenTools = new Map<string, string[]>();
  let workerRefusal = "";
  let reviewTask = "";
  llm.complete = async (_selection, messages, tools) => {
    const identity = [...messages].reverse().find((m) => m.content?.startsWith("<multi_agent_role>"))!.content!;
    const path = /You are (\/root[^,]*)/.exec(identity)![1]!;
    const round = seenTools.has(path) ? 1 : 0;
    seenTools.set(path, tools.map((t) => t.function.name));
    const call = (name: string, args: Json) => ({ id: crypto.randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    let calls;
    let text: string | null = `${path} report`;
    if (path === "/root" && round === 0) {
      text = null;
      calls = [
        call("agents__spawn_agent", { task_name: "research", role: "explorer", message: "Collect sources", notice: "出典を集めます" }),
        call("agents__spawn_agent", { task_name: "draft", role: "worker", message: "Write draft.md", notice: "下書きを作ります" }),
      ];
    } else if (path === "/root/draft" && round === 0) {
      // A worker that tries to deliver is refused by the loop's registry.
      text = null;
      calls = [call("mcp__workspace__send_file", { path: "draft.md" })];
    } else if (path === "/root/draft")
      workerRefusal = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    else if (path === "/root/final_review") {
      reviewTask = messages.find((m) => m.content?.includes("Final review requested by the runtime"))?.content ?? "";
      text = "VERDICT: FAIL\n- 出典が本文にありません。";
    } else if (path === "/root")
      text = messages.some((m) => m.content?.startsWith("The runtime's independent reviewer"))
        ? "完成した本文です（出典付き）。"
        : "完成した本文です。";
    return { message: { role: "assistant", content: text, tool_calls: calls }, usage: emptyUsage(), incomplete: false };
  };
  const agent = new Agent(llm), client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, agent);
  registry.sandbox.available = true;
  const ctx = context();
  const notices: string[] = [];
  ctx.notify = async (text) => { notices.push(text); };
  const base = options(ctx, runtime, [
    ...(await assemblePrompt(runtime, ctx, "")),
    { role: "user", content: "資料を調べて本文を書いて", turnStart: true },
  ]);
  base.execute = (name, args, c) => registry.execute(name, args, c);
  try {
    const result = await new MultiAgentSession(runtime, agent, (c) => registry.tools(c)).runRoot(base);
    expect(result.text).toBe("完成した本文です（出典付き）。");
    // The reviewer judged the exact candidate and could not edit files.
    expect(reviewTask).toContain("<<<\n完成した本文です。\n>>>");
    expect(seenTools.get("/root/final_review")).toContain("shell_command");
    expect(seenTools.get("/root/final_review")).not.toContain("apply_patch");
    expect(result.messages.some((m) => m.content?.includes("VERDICT: FAIL"))).toBe(true);
    expect(seenTools.get("/root")).toContain("agents__spawn_agent");
    expect(seenTools.get("/root/research")).not.toContain("shell_command");
    expect(seenTools.get("/root/draft")).not.toContain("mcp__workspace__send_file");
    expect(workerRefusal).toContain("Tool unavailable: mcp__workspace__send_file");
    expect(result.messages.some((m) => m.content?.includes("/root/draft report"))).toBe(true);
    expect(notices.sort()).toEqual([
      "サブエージェント（作成）: GPT 6.1 Sol\n下書きを作ります",
      "サブエージェント（検証）: GPT 6.1 Sol\n回答案を検証します。",
      "サブエージェント（調査）: GPT 6.1 Sol\n出典を集めます",
    ]);
    expect(ctx.delivered).toBe(false);
  } finally { await registry.close(); client.destroy(); }
});

async function gateRun(opts: {
  env?: NodeJS.ProcessEnv;
  triage?: Record<string, number>;
  spawnFirst?: { task_name: string; role: string }[];
  reviewer?: (o: AgentOptions) => Promise<string>;
  reviewTimeoutMs?: number;
  steering?: AbortController;
}) {
  const runtime = new Runtime(config({ MULTI_AGENT: "true", ...opts.env }));
  const records: Json[] = [];
  const log = pino({ level: "info" }, { write: (line) => { records.push(JSON.parse(line)); } });
  const ctx = context();
  const notices: string[] = [];
  ctx.notify = async (text) => { notices.push(text); };
  const reviewerTasks: string[] = [];
  let returned: Message[] | undefined;
  const agent = {
    run: async (o: AgentOptions) => {
      const c = o.context;
      if (c.agentPath !== "/root") {
        const task = o.takeSteering!().map((m) => m.content ?? "").join("\n");
        if (c.agentRole === "reviewer" && task.includes("Final review requested")) {
          reviewerTasks.push(task);
          return { text: await (opts.reviewer ?? (async () => "VERDICT: PASS"))(o), messages: o.messages, usage: emptyUsage(), rounds: 1 };
        }
        return { text: `${c.agentPath} done`, messages: o.messages, usage: emptyUsage(), rounds: 1 };
      }
      for (const spawn of opts.spawnFirst ?? [])
        await c.team!.execute("spawn_agent", { ...spawn, message: "work", notice: "作業します" }, c);
      // Collect every child result first; without a candidate the gate is inert.
      while ((await o.beforeFinal!()).length);
      returned = await o.beforeFinal!("回答案の本文");
      return { text: "done", messages: o.messages, usage: emptyUsage(), rounds: 1 };
    },
  } as Agent;
  const session = new MultiAgentSession(runtime, agent, () => [], {
    log,
    reviewTimeoutMs: opts.reviewTimeoutMs,
    ...(opts.triage ? { triage: async () => ({ triage: opts.triage as never, usage: emptyUsage() }) } : {}),
  });
  const base = options(ctx, runtime, [{ role: "user", content: "本文を書いて", turnStart: true }]);
  if (opts.steering) base.requestSignal = () => opts.steering!.signal;
  await session.runRoot(base);
  return { returned: returned!, notices, reviewerTasks, review: records.find((r) => r.msg === "Multi-Agent review finished") };
}

test("review gate: a passing review delivers the candidate without another root call", async () => {
  const run = await gateRun({ spawnFirst: [{ task_name: "draft", role: "worker" }] });
  expect(run.returned).toEqual([]);
  expect(run.reviewerTasks[0]).toContain("<<<\n回答案の本文\n>>>");
  expect(run.notices).toContain("サブエージェント（検証）: GPT 6.1 Sol\n回答案を検証します。");
  expect(run.review).toMatchObject({ trigger: "worker", verdict: "pass" });
  expect(JSON.stringify(run.review)).not.toContain("回答案の本文");
});

test("review gate: failing or unparsed reports return to root with a full-rewrite instruction", async () => {
  for (const [report, verdict] of [["**VERDICT: FAIL**\n- 数値が違う", "fail"], ["数値が違う", "unparsed"]] as const) {
    const run = await gateRun({ spawnFirst: [{ task_name: "draft", role: "worker" }], reviewer: async () => report });
    expect(run.returned.some((m) => m.content?.includes(report))).toBe(true);
    expect(run.returned.at(-1)!.content).toContain("write the complete final answer again in full");
    expect(run.review).toMatchObject({ verdict });
  }
});

test("review gate triggers on triage or unscored children and stays off otherwise", async () => {
  const cases = [
    { name: "triage", opts: { triage: { needs_research: 0.2, needs_artifact_work: 0.1, needs_review: 0.8 } }, trigger: "triage" },
    { name: "no triage", opts: { spawnFirst: [{ task_name: "look", role: "explorer" }] }, trigger: "children" },
    { name: "low review", opts: { triage: { needs_research: 0.2, needs_artifact_work: 0.1, needs_review: 0.2 }, spawnFirst: [{ task_name: "look", role: "explorer" }] }, trigger: undefined },
    { name: "own reviewer", opts: { spawnFirst: [{ task_name: "draft", role: "worker" }, { task_name: "check", role: "reviewer" }] }, trigger: undefined },
    { name: "ultra", opts: { env: { MULTI_AGENT: "false", ULTRA_MODE: "true" }, spawnFirst: [{ task_name: "draft", role: "worker" }] }, trigger: undefined },
  ];
  for (const c of cases) {
    const run = await gateRun(c.opts);
    expect([c.name, run.review?.trigger]).toEqual([c.name, c.trigger]);
    if (!c.trigger) expect([c.name, run.reviewerTasks]).toEqual([c.name, []]);
  }
});

test("review gate delivers the candidate when the reviewer times out or the user steers", async () => {
  const stuck = (o: AgentOptions) => new Promise<string>((_, reject) =>
    o.context.signal!.addEventListener("abort", () => reject(o.context.signal!.reason), { once: true }));
  const timeout = await gateRun({ spawnFirst: [{ task_name: "draft", role: "worker" }], reviewer: stuck, reviewTimeoutMs: 20 });
  expect(timeout.returned).toEqual([]);
  expect(timeout.review).toMatchObject({ verdict: "timeout" });
  const steering = new AbortController();
  const steered = await gateRun({
    spawnFirst: [{ task_name: "draft", role: "worker" }], steering,
    reviewer: (o) => { setTimeout(() => steering.abort(), 5); return stuck(o); },
  });
  expect(steered.returned).toEqual([]);
  expect(steered.review).toMatchObject({ verdict: "steered" });
});

test("per-role overrides pick the reviewer's model and effort without changing other roles", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  const ctx = context();
  const parent = { provider: "codex_plus", model: "gpt-6.1-sol", effort: "max" };
  runtime.snapshot.guilds.g1 = {
    ...emptyGuild(), ...subagentModePatch("multi"),
    subagent_model: { mode: "fixed", preset: "plus-luna" },
    subagent_effort: { mode: "fixed", effort: "high" },
    multi_agent_roles: {
      explorer: { model: { mode: "default" }, effort: { mode: "default" } },
      worker: { model: { mode: "same" }, effort: { mode: "same" } },
      reviewer: { model: { mode: "fixed", preset: "pro-sol" }, effort: { mode: "fixed", effort: "xhigh" } },
    },
  };
  expect(selectChild(runtime, ctx, parent, {}, "explorer")).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "high" });
  expect(selectChild(runtime, ctx, parent, {}, "worker")).toEqual(parent);
  expect(selectChild(runtime, ctx, parent, { model: "plus-luna", reasoning_effort: "low" }, "reviewer"))
    .toEqual({ provider: "codex_pro", model: "gpt-6.1-sol", effort: "xhigh" });
  // Ultra children have no role and keep the common policy.
  expect(selectChild(runtime, ctx, parent, {})).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "high" });
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  try {
    const spawn = registry.tools({ ...ctx, team: {} as Context["team"] }).find((t) => t.function.name === "agents__spawn_agent")!;
    expect(spawn.function.description).toContain("Per-role overrides");
    expect(spawn.function.description).toContain("pro-sol");
  } finally { await registry.close(); client.destroy(); }
  // An account without the reviewer's plan cannot save or use it.
  runtime.config.endpoints.codex_pro!.apiKey = "";
  expect(() => selectChild(runtime, ctx, parent, {}, "reviewer")).toThrow("unavailable");
  await expect(runtime.patch("g1", { multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "fable-5" } } } }, "u1"))
    .rejects.toThrow("unavailable");
});

test("an intentional interrupt reports a stopped assignment, not unfinished work", async () => {
  const runtime = new Runtime(config({ MULTI_AGENT: "true" }));
  const ctx = context();
  let report = "";
  const agent = {
    run: async (o: AgentOptions) => {
      const c = o.context;
      if (c.agentPath !== "/root")
        return new Promise((_, reject) => {
          // The interrupt can land before this fake starts listening.
          if (c.signal!.aborted) reject(c.signal!.reason);
          c.signal!.addEventListener("abort", () => reject(c.signal!.reason), { once: true });
        });
      await c.team!.execute("spawn_agent", { task_name: "slow", role: "explorer", message: "m", notice: "調べます" }, c);
      await c.team!.execute("interrupt_agent", { target: "slow" }, c);
      while (!report) report = (await o.beforeFinal!()).map((m) => m.content ?? "").join("\n");
      return { text: "done", messages: o.messages, usage: emptyUsage(), rounds: 1 };
    },
  } as Agent;
  await new MultiAgentSession(runtime, agent, () => []).runRoot(options(ctx, runtime, [{ role: "user", content: "go", turnStart: true }]));
  expect(report).toContain("interrupted: Stopped on purpose by /root");
  expect(report).toContain("not unfinished user work");
});
