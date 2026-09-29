import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message as DiscordMessage } from "discord.js";
import { Client } from "discord.js";
import pino from "pino";
import { Agent } from "../agent";
import { Hibana } from "../bot";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import { emptyUsage, type Context, type Json, type Message, type ToolCall, type ToolDef } from "../types";
import {
  systemReminder,
  ULTRACODE_ENTER_FULL,
  ULTRACODE_ENTER_SPARSE,
  ULTRACODE_EXIT,
  WORKFLOW_KEYWORD_REMINDER,
} from "../ultracode";
import { WORKFLOW_SUBAGENT_PROMPT, WORKFLOW_SUBAGENT_SCHEMA_PROMPT } from "../workflow/prompts";
import { emptyUserOverride } from "@hibana/shared/settings";

const USER = "20000", CHANNEL = "10000";
const dm = (): Context => ({ channelId: CHANNEL, userId: USER, botId: "30000", thread: false, depth: 0, delivered: false });
const call = (name: string, args: Json): ToolCall => ({
  id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string | null, calls?: ToolCall[]) => ({
  message: { role: "assistant" as const, content, tool_calls: calls },
  usage: { ...emptyUsage(), completion_tokens: 3, total_tokens: 5 },
  incomplete: false,
});
const isRoot = (messages: Message[]) => messages.some((m) => m.content?.startsWith("<multi_agent_role>You are /root,"));
const lastToolResult = (messages: Message[]) => JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content!);
const has = (messages: Message[], text: string) => messages.some((m) => m.content?.includes(text));
const notification = (messages: Message[]) =>
  [...messages].reverse().find((m) => m.content?.includes("<task-notification>"))?.content ?? undefined;

async function fixture(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hibana-ultracode-"));
  const records: Json[] = [];
  const bot = new Hibana(loadConfig({
    HIBANA_DATA_DIR: dir, PROVIDER: "codex_plus", LLM_MODEL: "gpt-6-luna", CODEX_PLUS_API_KEY: "fixture",
    LLM_EFFORT: "low", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", JEV_ENABLED: "false", LOG_DIR: "",
    WORKFLOW_MAX_CONCURRENT_AGENTS: "2", HISTORY_LIMIT: "50", ...env,
  }), pino({ level: "info" }, { write: (line) => { records.push(JSON.parse(line)); } }));
  (bot.client as { user: { id: string } | null }).user = { id: "30000" };
  // Messages keep their latest content so a status message shows its last edit.
  const posted: { content: string }[] = [];
  bot.client.channels.fetch = (async () => ({
    id: CHANNEL, isSendable: () => true, sendTyping: async () => {},
    send: async (value: { content: string }) => {
      const message = { ...value };
      posted.push(message);
      return { id: String(posted.length), edit: async (next: { content: string }) => { message.content = next.content; } };
    },
  })) as never;
  const workspace = join(dir, "workspaces", "dms", CHANNEL);
  return {
    bot, dir, records, posted, workspace,
    cleanup: async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

const SCRIPT = `export const meta = {
  name: 'compare',
  description: 'Compare two cities',
  phases: [{ title: 'Research' }, { title: 'Verify' }],
}
phase('Research')
const facts = await parallel(['Tokyo', 'Osaka'].map(c => () => agent('Weather facts for ' + c, { label: c })))
phase('Verify')
const verdict = await agent('Check the facts: ' + facts.join(' / '), {
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
})
log('verified')
return { facts, verdict }`;

test("an Ultracode turn runs a workflow at xhigh and answers from its notification", async () => {
  const f = await fixture({ ULTRA_MODE: "true" });
  const rootRounds: Message[][] = [];
  const agentPrompts: string[] = [];
  let verifierCalls = 0;
  f.bot.llm.complete = async (selection, messages, tools) => {
    const names = tools.map((t) => t.function.name);
    expect(selection).toEqual({ provider: "codex_plus", model: "gpt-6-luna", effort: "xhigh" });
    if (isRoot(messages)) {
      rootRounds.push(messages);
      expect(names).toEqual(expect.arrayContaining(["Workflow", "TaskStop", "agents__spawn_agent"]));
      // A fast workflow can finish before root's next request; its notice is
      // then already in that request (delivered at the message boundary).
      const notified = has(messages, "<task-notification>");
      if (rootRounds.length === 1) {
        // The reminder follows the typed prompt, like Claude Code's attachment.
        const prompt = messages.findIndex((m) => m.turnStart && m.content?.startsWith("Compare Tokyo"));
        expect(messages[prompt + 1]).toEqual({ role: "user", internal: true, content: systemReminder(ULTRACODE_ENTER_FULL) });
        expect(messages.find((m) => m.content?.startsWith("<multi_agent_mode>"))!.content).toContain("Do not spawn sub-agents");
        const description = tools.find((t) => t.function.name === "Workflow")!.function.description;
        expect(description).toContain("capped at 2 per workflow");
        return reply(null, [call("Workflow", { script: SCRIPT })]);
      }
      if (rootRounds.length === 2) {
        const launched = lastToolResult(messages);
        expect(launched).toMatchObject({ status: "async_launched", workflowName: "compare", summary: "Compare two cities" });
        expect(launched.message).toStartWith(`Workflow launched in background. Task ID: ${launched.taskId}`);
        expect(launched.scriptPath).toBe(`/workspace/.hibana/workflows/${launched.runId}.js`);
        if (!notified) return reply("ワークフローを起動しました。");
      }
      const notice = notification(messages)!;
      expect(notice).toStartWith("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]");
      expect(notice).toContain('<summary>Dynamic workflow "compare" completed</summary>');
      expect(notice).toContain('<result>{"facts":["facts:Tokyo","facts:Osaka"],"verdict":{"ok":true}}</result>');
      expect(notice).toContain("<agent_count>3</agent_count><agents_done>3</agents_done>");
      return reply("最終回答: 東京と大阪を比べました。");
    }
    // A workflow agent: its own system prompt, the AGENTS.md instructions and
    // the prompt only — no conversation, delegation or delivery tools.
    const prompt = messages.find((m) => m.turnStart)!.content!;
    agentPrompts.push(prompt);
    expect(has(messages, "# AGENTS.md instructions")).toBe(true);
    expect(has(messages, "Compare Tokyo")).toBe(false);
    expect(has(messages, "<multi_agent_mode>")).toBe(false);
    for (const hidden of ["Workflow", "TaskStop", "agents__spawn_agent", "request_user_input", "mcp__workspace__send_file", "mcp__discord__send_message"])
      expect(names).not.toContain(hidden);
    if (prompt.startsWith("Weather facts for ")) {
      expect(messages.some((m) => m.role === "developer" && m.content === WORKFLOW_SUBAGENT_PROMPT)).toBe(true);
      return reply(`facts:${prompt.slice(18)}`);
    }
    expect(messages.some((m) => m.role === "developer" && m.content === WORKFLOW_SUBAGENT_SCHEMA_PROMPT)).toBe(true);
    expect(prompt).toBe("Check the facts: facts:Tokyo / facts:Osaka");
    const schemaTool = tools.find((t) => t.function.name === "StructuredOutput")!;
    expect(schemaTool.function.parameters).toEqual({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    verifierCalls++;
    if (verifierCalls === 1) return reply(null, [call("StructuredOutput", { ok: "yes" })]);
    expect(lastToolResult(messages).error).toContain("Output does not match the schema");
    return reply(null, [call("StructuredOutput", { ok: true })]);
  };
  try {
    expect(await f.bot.respond("Compare Tokyo and Osaka weather", dm())).toBe("最終回答: 東京と大阪を比べました。");
    expect(rootRounds.length).toBeGreaterThanOrEqual(2);
    expect(agentPrompts.sort()).toEqual(["Check the facts: facts:Tokyo / facts:Osaka", "Check the facts: facts:Tokyo / facts:Osaka",
      "Weather facts for Osaka", "Weather facts for Tokyo"]);
    // Accepted StructuredOutput ends the agent without another model call.
    expect(verifierCalls).toBe(2);
    const status = f.posted.find((m) => m.content.startsWith("ワークフロー: compare"))!;
    expect(status.content).toStartWith("ワークフロー: compare（完了・エージェント 3・");
    expect(status.content).toContain("▸ Research — 2/2 完了");
    expect(status.content).toContain("▸ Verify — 1/1 完了");
    expect(status.content).toContain("> verified");
    const scripts = await readdir(join(f.workspace, ".hibana", "workflows"));
    expect(scripts).toHaveLength(1);
    expect(await readFile(join(f.workspace, ".hibana", "workflows", scripts[0]!), "utf8")).toBe(SCRIPT);
    const turn = f.records.find((r) => r.msg === "Turn started")!;
    expect(turn).toMatchObject({ ultracode: true, effort: "xhigh", ultra_mode: true });
    expect(f.records.find((r) => r.msg === "Workflow finished")).toMatchObject({ workflow: "compare", status: "completed", agents: 3, failed: 0 });
    // Operational logs never carry prompts, results or the script.
    expect(JSON.stringify(f.records)).not.toContain("Weather facts");
    expect(f.bot.history.info(CHANNEL).turns).toBe(1);
  } finally { await f.cleanup(); }
});

const incoming = (content: string, id: string): DiscordMessage => ({
  id, channelId: CHANNEL, guildId: null, content,
  author: { id: USER, bot: false, displayName: "user" }, member: null,
  mentions: { users: { has: () => false } }, pinned: false, system: false,
  attachments: new Map(), channel: { isThread: () => false, name: "dm" },
} as unknown as DiscordMessage);

test("the keyword opts one typed prompt in, and Ultracode reminders track the setting", async () => {
  const f = await fixture();
  const seen: { effort?: string | null; reminders: string[]; workflow: boolean }[] = [];
  const reminderTexts = [WORKFLOW_KEYWORD_REMINDER, ULTRACODE_ENTER_FULL, ULTRACODE_ENTER_SPARSE, ULTRACODE_EXIT];
  f.bot.llm.complete = async (selection, messages, tools) => {
    // Only the reminders attached after this turn's prompt.
    const start = messages.length - 1 - [...messages].reverse().findIndex((m) => m.turnStart);
    seen.push({
      effort: selection.effort,
      reminders: messages.slice(start + 1).flatMap((m) => reminderTexts.filter((t) => m.content === systemReminder(t))),
      workflow: tools.some((t) => t.function.name === "Workflow"),
    });
    return reply("了解です。");
  };
  const handle = (message: DiscordMessage) =>
    (f.bot as unknown as { onMessage(message: DiscordMessage): Promise<void> }).onMessage(message);
  const setUltra = (value: boolean) => {
    f.bot.runtime.snapshot.user_overrides[USER] = { ...emptyUserOverride(), ultra_mode: value };
  };
  try {
    await handle(incoming("ultracode: 全部調べて", "1"));
    await handle(incoming("run `ultracode` in quotes, /ultracode, ultracode.js", "2"));
    setUltra(true);
    // Claude Code counts prompts before the new one: ten prompts pass
    // between the full reminder and the sparse one.
    for (let i = 0; i < 12; i++) await handle(incoming(`質問 ${i}`, `3${i}`));
    setUltra(false);
    await handle(incoming("通常に戻して", "4"));
    await handle(incoming("もう一度", "5"));
    expect(seen[0]).toEqual({ effort: "low", reminders: [WORKFLOW_KEYWORD_REMINDER], workflow: true });
    expect(seen[1]).toEqual({ effort: "low", reminders: [], workflow: true });
    expect(seen[2]).toEqual({ effort: "xhigh", reminders: [ULTRACODE_ENTER_FULL], workflow: true });
    expect(seen.slice(3, 13).every((s) => s.reminders.length === 0 && s.effort === "xhigh")).toBe(true);
    expect(seen[13]).toEqual({ effort: "xhigh", reminders: [ULTRACODE_ENTER_SPARSE], workflow: true });
    expect(seen[14]).toEqual({ effort: "low", reminders: [ULTRACODE_EXIT], workflow: true });
    expect(seen[15]).toEqual({ effort: "low", reminders: [], workflow: true });
    // Turning Ultra on/off did not reset the DM conversation.
    expect(f.bot.history.info(CHANNEL).turns).toBe(16);
  } finally { await f.cleanup(); }
});

test("TaskStop ends a run without a notification and a later turn resumes its completed agents", async () => {
  const f = await fixture({ ULTRA_MODE: "true" });
  const script = `export const meta = { name: 'pair', description: 'Two checks' }
const [fast, slow] = await parallel([() => agent('fast check'), () => agent('slow check')])
return { fast, slow }`;
  const runs: Record<string, number> = {};
  let turn = 0, runId = "", taskId = "", rootRound = 0, hold = true;
  const slowStarted = Promise.withResolvers<void>();
  f.bot.llm.complete = async (_selection, messages, _tools, options) => {
    if (!isRoot(messages)) {
      const prompt = messages.find((m) => m.turnStart)!.content!;
      runs[prompt] = (runs[prompt] ?? 0) + 1;
      if (prompt === "slow check" && hold) {
        slowStarted.resolve();
        await new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason)));
      }
      return reply(`${prompt} done`);
    }
    rootRound++;
    if (turn === 1) {
      if (rootRound === 1) return reply(null, [call("Workflow", { script })]);
      if (rootRound === 2) {
        ({ runId, taskId } = lastToolResult(messages));
        await slowStarted.promise;
        return reply(null, [call("TaskStop", { task_id: taskId })]);
      }
      expect(lastToolResult(messages)).toMatchObject({ success: true, task_id: taskId, run_id: runId });
      expect(has(messages, "<task-notification>")).toBe(false);
      return reply("止めました。");
    }
    if (rootRound === 1) {
      expect(messages.some((m) => m.content === "止めました。")).toBe(true);
      hold = false;
      return reply(null, [call("Workflow", { script, resumeFromRunId: runId })]);
    }
    const notice = notification(messages);
    if (!notice) return reply("再開しました。");
    expect(notice).toContain('<result>{"fast":"fast check done","slow":"slow check done"}</result>');
    return reply("両方終わりました。");
  };
  try {
    turn = 1;
    expect(await f.bot.respond("Run both checks", dm())).toBe("止めました。");
    expect(f.posted.find((m) => m.content.startsWith("ワークフロー: pair"))!.content).toStartWith("ワークフロー: pair（停止");
    turn = 2; rootRound = 0;
    expect(await f.bot.respond("Resume them", dm())).toBe("両方終わりました。");
    // "fast" completed before the stop and replayed from the journal; "slow"
    // was running, so it restarted without breaking the cached prefix.
    expect(runs).toEqual({ "fast check": 1, "slow check": 2 });
    expect(f.posted.filter((m) => m.content.startsWith("ワークフロー: pair")).at(-1)!.content).toContain("1 再利用");
  } finally { await f.cleanup(); }
});

test("saved workflows, syntax errors and missing runs are reported to the model", async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, ".claude", "workflows"), { recursive: true });
  await writeFile(join(f.workspace, ".claude", "workflows", "daily.js"),
    "export const meta = { name: 'daily', description: 'Daily digest' }\nreturn await agent('Digest about ' + args.topic)");
  let round = 0;
  f.bot.llm.complete = async (_selection, messages) => {
    if (!isRoot(messages)) return reply(`digest:${messages.find((m) => m.turnStart)!.content}`);
    round++;
    if (round === 1)
      return reply(null, [
        call("Workflow", { script: "export const meta = { name: 'bad', description: 'x' }\nconst files: string[] = []" }),
        call("Workflow", { name: "nope" }),
        call("Workflow", { script: "phase('x')" }),
        call("Workflow", { script: "export const meta = { name: 'r', description: 'x' }\nreturn 1", resumeFromRunId: "wf_unknown1" }),
        call("Workflow", {}),
      ]);
    if (round === 2) {
      const results = messages.filter((m) => m.role === "tool").slice(-5).map((m) => JSON.parse(m.content!).error);
      expect(results[0]).toBe("Workflow script has a syntax error and was not launched:\nSyntaxError: missing initializer for const variable (line 2)");
      expect(results[1]).toBe('Workflow "nope" not found. Available: (daily)');
      expect(results[2]).toContain("Every script must begin with `export const meta = {...}`");
      expect(results[3]).toContain("nothing to resume");
      expect(results[4]).toBe("Must provide script, name, or scriptPath");
      return reply(null, [call("Workflow", { name: "daily", args: { topic: "rain" } })]);
    }
    const notice = notification(messages);
    if (!notice) {
      expect(lastToolResult(messages)).toMatchObject({ status: "async_launched", workflowName: "daily" });
      return reply("待機します。");
    }
    expect(notice).toContain('<result>"digest:Digest about rain"</result>');
    return reply("まとめました。");
  };
  try {
    expect(await f.bot.respond("use a workflow: daily digest", dm())).toBe("まとめました。");
  } finally { await f.cleanup(); }
});

test("workflow agents cannot reach delegation, workflows or user-visible tools", async () => {
  const runtime = new Runtime(loadConfig({ RUNTIME_STATE_PATH: "", SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", MULTI_AGENT: "true" }));
  const client = new Client({ intents: [] });
  const registry = new ToolRegistry(runtime, client, new Agent(new LlmClient(runtime.config)));
  registry.sandbox.available = true;
  const names = (ctx: Context) => registry.tools(ctx).map((t: ToolDef) => t.function.name);
  const agentCtx: Context = { ...dm(), guildId: "g1", depth: 1, workflowAgent: true };
  try {
    const visible = names(agentCtx);
    expect(visible).toEqual(expect.arrayContaining(["shell_command", "apply_patch", "view_image", "mcp__workspace__download_file"]));
    for (const hidden of ["Workflow", "TaskStop", "agents__spawn_agent", "agents__send_message", "request_user_input",
      "mcp__workspace__send_file", "mcp__discord__send_message", "mcp__sites__publish_site", "mcp__settings__set_bot_model"])
      expect(visible).not.toContain(hidden);
    await expect(registry.execute("send_file", { path: "a.txt" }, agentCtx)).rejects.toThrow("Workflow agents cannot use send_file");
    await expect(registry.execute("use_tool", { tool_name: "request_user_input", arguments: {} }, agentCtx)).rejects.toThrow("cannot use request_user_input");
    await expect(registry.execute("Workflow", { script: "x" }, agentCtx)).rejects.toThrow("cannot use Workflow");
    // A role picked with opts.agentType narrows further.
    expect(names({ ...agentCtx, agentRole: "explorer" })).not.toContain("shell_command");
    // Root: Multi-Agent offers Workflow only on keyword turns; no team, no tool.
    const root: Context = { ...dm(), guildId: "g1", team: {} as Context["team"] };
    expect(names(root)).not.toContain("Workflow");
    expect(names({ ...root, workflowKeyword: true })).toContain("Workflow");
    expect(names({ ...root, team: undefined, workflowKeyword: true })).not.toContain("Workflow");
    await expect(registry.execute("Workflow", { script: "x" }, root)).rejects.toThrow("Tool disabled for this context");
  } finally { await registry.close(); client.destroy(); }
});

test("with a skill tool the reference is the workflow-authoring skill, autoloaded once on keyword and Ultracode turns", async () => {
  const f = await fixture({ SKILLS_ENABLED: "true" });
  const handle = (message: DiscordMessage) =>
    (f.bot as unknown as { onMessage(message: DiscordMessage): Promise<void> }).onMessage(message);
  const loaded = (messages: Message[]) =>
    messages.filter((m) => m.internal && m.content?.startsWith("<command-name>workflow-authoring</command-name>")).length;
  const turns: { autoloaded: number; description: string; catalog: boolean; skill?: Json }[] = [];
  let loadSkill = false;
  f.bot.llm.complete = async (_selection, messages, tools) => {
    if (loadSkill && !messages.some((m) => m.role === "tool")) {
      return reply(null, [call("mcp__skills__use_skill", { name: "workflow-authoring" })]);
    }
    turns.push({
      autoloaded: loaded(messages),
      description: tools.find((t) => t.function.name === "Workflow")!.function.description,
      catalog: has(messages, "- workflow-authoring: Reference for writing a Workflow tool script"),
      skill: messages.some((m) => m.role === "tool") ? lastToolResult(messages) : undefined,
    });
    return reply("了解です。");
  };
  try {
    await handle(incoming("hello", "1"));
    await handle(incoming("ultracode: survey the docs", "2"));
    await handle(incoming("ultracode again", "3"));
    f.bot.runtime.snapshot.user_overrides[USER] = { ...emptyUserOverride(), ultra_mode: true };
    await handle(incoming("now in Ultracode", "4"));
    loadSkill = true;
    await handle(incoming("load it yourself", "5"));
    const pointer = "Before writing a script, load the `workflow-authoring` skill";
    expect(turns.every((t) => t.description.includes(pointer) && !t.description.includes("# Workflow authoring reference"))).toBe(true);
    expect(turns.every((t) => t.catalog)).toBe(true);
    // Keyword turn loads it; the conversation keeps it, so later keyword and
    // full-reminder turns do not add a second copy.
    expect(turns.map((t) => t.autoloaded)).toEqual([0, 1, 1, 1, 1]);
    const skill = turns[4]!.skill!;
    expect(skill.name).toBe("workflow-authoring");
    expect(String(skill.content)).toStartWith("# Workflow authoring reference");
    expect(String(skill.content)).toContain("capped at 2 per workflow");
    expect(f.posted.some((m) => m.content === "Skill: workflow-authoring")).toBe(true);
  } finally { await f.cleanup(); }
});
