import type { JevClient } from "../jev";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "discord.js";
import pino from "pino";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import { Agent } from "../agent";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { assemblePrompt, multiAgentModeMessage, normalizeTool } from "../harness";
import { collaborationTools } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { LlmClient } from "../llm";
import { ToolRegistry } from "../tools";
import { emptyUsage, type Context, type Json, type ToolCall } from "../types";
import { turnSelection, ultracodeActive } from "../ultracode";

const context = (): Context => ({
  channelId: "10000", userId: "20000", botId: "30000", thread: false, depth: 0, delivered: false,
});
const call = (name: string, args: Json): ToolCall => ({
  id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
});

test("every catalog model keeps Ultra, Jev evaluation and Jev actions independent", async () => {
  const runtime = new Runtime(loadConfig({
    JEV_API_KEY: "fixture", RUNTIME_STATE_PATH: "", SKILLS_ENABLED: "false", SANDBOX_ENABLED: "false",
  }));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  registry.sandbox.available = true;
  const ctx = { ...context(), team: {} as Context["team"] };
  runtime.snapshot.user_roles[ctx.userId] = "administrator";
  try {
    for (const preset of MODEL_PRESETS) {
      runtime.config.selection = { provider: preset.provider, model: preset.model, effort: "low" };
      for (const ultra of [false, true]) for (const evaluation of [false, true]) for (const actions of [false, true]) {
        runtime.config.ultraMode = ultra;
        runtime.config.jevEnabled = evaluation;
        runtime.config.jevTaskEnabled = actions;
        const settings = runtime.resolve(undefined, ctx.userId);
        const prompt = await assemblePrompt(runtime, ctx, "");
        const tools = registry.tools(ctx);
        const names = tools.map(t => t.function.name);
        expect(settings.selection).toEqual(runtime.config.selection);
        // Ultra is Claude Code's Ultracode: xhigh for the turn, the explicit
        // policy for individual agents, and the Workflow tool in both modes.
        expect(turnSelection(settings.selection, ultracodeActive(runtime.config, settings)).effort).toBe(ultra ? "xhigh" : "low");
        expect(prompt.find(m => m.content?.startsWith("<multi_agent_mode>"))).toEqual(multiAgentModeMessage(false));
        expect(names.includes("Workflow")).toBe(true);
        expect(prompt.some(m => m.content?.startsWith("Jev evaluation is enabled"))).toBe(evaluation);
        expect(names.includes("mcp__agent__run_jev")).toBe(evaluation);
        expect(names.includes("mcp__agent__run_jev_task")).toBe(actions);
        expect(names.includes("shell_command")).toBe(!actions);
        for (const t of collaborationTools) expect(names).toContain(`agents__${t.function.name}`);
        if (actions) {
          const description = tools.find(t => t.function.name === "mcp__agent__run_jev_task")!.function.description;
          const embedded = JSON.parse(description.split("\n").at(-1)!);
          const direct = new Set(tools.map(t => normalizeTool(t.function.name, {}).name));
          expect(embedded.length).toBeGreaterThan(0);
          for (const action of embedded) expect(direct.has(action.name)).toBe(false);
          const child = registry.tools({ ...ctx, depth: 1 });
          expect(child.some(t => t.function.name === "shell_command")).toBe(true);
          expect(child.some(t => t.function.name === "mcp__agent__run_jev_task")).toBe(false);
        }
      }
    }
  } finally { await registry.close(); client.destroy(); }
});

test("Ultra workers run alongside Jev and keep their notices after parent progress edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-ultra-jev-"));
  const records: Json[] = [];
  const bot = new Hibana(loadConfig({
    HIBANA_DATA_DIR: dir, PROVIDER: "codex_plus", LLM_MODEL: "gpt-6-luna", CODEX_PLUS_API_KEY: "chat-fixture",
    ULTRA_MODE: "true", LLM_EFFORT: "low", JEV_API_KEY: "jev-fixture", JEV_ENABLED: "true", JEV_TASK_ENABLED: "true",
    SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", LOG_DIR: "",
  }), pino({ level: "info" }, { write: line => { records.push(JSON.parse(line)); } }));
  bot.tools.sandbox.available = true;
  const posted: { content: string }[] = [], events: string[] = [];
  const workerStarted = Promise.withResolvers<void>();
  const jevStarted = Promise.withResolvers<void>();
  let rootCalls = 0, childCalls = 0;
  bot.runtime.snapshot.user_overrides["20000"] = { ...bot.runtime.guild(), service_tier: "priority" };
  bot.llm.complete = async (selection, messages, tools, options) => {
    expect(options?.serviceTier).toBe("priority");
    // Ultracode sends xhigh; the worker inherits the parent's effort.
    expect(selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "xhigh" });
    expect(messages.filter(m => m.content?.startsWith("<multi_agent_mode>")).at(-1)).toEqual(multiAgentModeMessage(false));
    const identity = [...messages].reverse().find(m => m.content?.startsWith("<multi_agent_role>"))!.content!;
    const child = identity.includes("You are /root/worker,");
    let calls: ToolCall[] = [];
    if (child) {
      childCalls++;
      expect(tools.some(t => t.function.name === "mcp__agent__run_jev_task")).toBe(false);
      expect(tools.some(t => t.function.name === "shell_command")).toBe(true);
      events.push("worker"); workerStarted.resolve();
      await jevStarted.promise;
    } else if (rootCalls++ === 0) {
      calls = [
        call("agents__spawn_agent", { task_name: "worker", message: "PRIVATE independent task", notice: "独立した調査を進めます", fork_turns: "none" }),
        call("mcp__agent__run_jev_task", { objective: "PRIVATE local check", state: "Inspect this branch", actions: [
          { id: "list", description: "List files", tool: "list_files", arguments: {} },
        ] }),
      ];
    } else {
      expect(messages.some(m => m.content?.includes("Message Type: FINAL_ANSWER") && m.content.includes("Worker evidence"))).toBe(true);
      if (rootCalls === 2) calls = [call("mcp__settings__get_bot_settings", {})];
    }
    return { message: { role: "assistant", content: child ? "Worker evidence" : calls.length ? "結果を整理しています。" : "統合完了。", tool_calls: calls },
      usage: emptyUsage(), incomplete: false };
  };
  bot.tools.jev.decide = async (input): Promise<Awaited<ReturnType<JevClient["decide"]>>> => {
    if ("completion" in input.questions) return { model: "~typesafe/jev-latest", answers: { completion: { type: "choice", choice: "complete" } }, usage: emptyUsage(), cost: 0 };
    await workerStarted.promise;
    events.push("jev"); jevStarted.resolve();
    return { model: "~typesafe/jev-latest", answers: { action: { type: "choice", choice: "a0" } }, usage: emptyUsage(), cost: 0 };
  };
  bot.client.channels.fetch = (async () => ({
    id: "10000", isSendable: () => true, sendTyping: async () => {},
    send: async (value: { content: string }) => {
      const message = { ...value }; posted.push(message);
      return { id: String(posted.length), edit: async (next: { content: string }) => { message.content = next.content; } };
    },
  })) as never;
  try {
    expect(await bot.respond("Complete both independent checks", context())).toBe("統合完了。");
    expect(events).toEqual(["worker", "jev"]);
    expect(childCalls).toBe(1);
    expect(posted.filter(m => m.content === "サブエージェント: GPT 6 Luna\n独立した調査を進めます")).toHaveLength(1);
    expect(posted.some(m => m.content.startsWith("サブ: Jev"))).toBe(true);
    const control = records.filter(r => r.msg === "Agent collaboration finished");
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({ tool: "agents__spawn_agent", ok: true, ultra_mode: true, agent_depth: 0 });
    expect(records.some(r => r.msg === "Jev decision finished")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  } finally {
    workerStarted.resolve(); jevStarted.resolve();
    await bot.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("subagent off hides and rejects collaboration while personal and guild choices remain isolated", async () => {
  const runtime = new Runtime(loadConfig({
    JEV_API_KEY: "fixture", RUNTIME_STATE_PATH: "", SKILLS_ENABLED: "false", SANDBOX_ENABLED: "false",
  }));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  const ctx = { ...context(), guildId: "guild", team: { execute: () => { throw new Error("must not execute"); } } as unknown as Context["team"] };
  try {
    await runtime.patch("guild", { subagent_enabled: false, ultra_mode: true }, ctx.userId);
    expect(runtime.resolve("other", ctx.userId).subagent_enabled).toBe(true);
    expect(runtime.resolve(undefined, ctx.userId).subagent_enabled).toBe(true);
    const names = registry.tools(ctx).map(t => t.function.name);
    expect(names.some(n => n.startsWith("agents__"))).toBe(false);
    expect(names).toContain("mcp__agent__run_jev");
    const prompt = await assemblePrompt(runtime, ctx, "");
    expect(prompt.some(m => m.content?.includes("Subagents are disabled"))).toBe(true);
    await expect(registry.execute("agents__spawn_agent", { task_name: "worker", message: "task", notice: "調査" }, ctx)).rejects.toThrow();
    runtime.snapshot.user_overrides[ctx.userId] = runtime.guild("other");
    expect(runtime.resolve("guild", ctx.userId).subagent_enabled).toBe(true);
    expect(registry.tools(ctx).some(t => t.function.name === "agents__spawn_agent")).toBe(true);
    runtime.snapshot.user_overrides[ctx.userId]!.subagent_enabled = false;
    expect(runtime.resolve(undefined, ctx.userId).subagent_enabled).toBe(false);
    expect(runtime.resolve("other", "another-user").subagent_enabled).toBe(true);
  } finally { await registry.close(); client.destroy(); }
});
