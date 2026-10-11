import type { Logger } from "pino";
import type { Agent } from "../agent";
import type { Selection } from "../config";
import { Semaphore } from "../io";
import { nativeSearchFor } from "../llm";
import type { Runtime } from "../runtime";
import { scopedContext, type Context, type Json, type ToolDef } from "../types";
import { subagentSystem } from "./prompt";
import type { AgentCall } from "./tools";

// Subagents of the Claude harness (#68), shaped like Claude Code's Agent tool:
// a child gets a task and nothing else, works in its own context, and only its
// last message returns to the parent. It runs in the foreground: the parent's
// tool call resolves when the child is done, and several calls made in one
// response run side by side.

const EXPLORE: Selection = { provider: "anthropic", model: "claude-haiku-5-5", effort: "medium" };

export class ClaudeAgents {
  private all: Semaphore;
  // One gate per turn, keyed by the turn's shared counter.
  private turns = new WeakMap<object, Semaphore>();
  constructor(
    private runtime: Runtime,
    private agent: Agent,
    private tools: (ctx: Context) => ToolDef[],
    private execute: (name: string, args: Json, ctx: Context) => Promise<unknown>,
    private log?: Logger,
  ) {
    this.all = new Semaphore(runtime.config.claudeAgentConcurrency);
  }

  async run(call: AgentCall, parent: Context): Promise<string> {
    const config = this.runtime.config;
    if (parent.depth > 0) throw new Error("A subagent cannot start subagents. Do this part of the task yourself.");
    const calls = (parent.agentCalls ??= { count: 0 });
    // The limits are what bounds a turn's spend on subagents: there is no
    // dollar limit yet (#68).
    if (calls.count >= config.claudeAgentsPerTurn)
      throw new Error(`This turn has already started ${calls.count} subagents, which is the limit. Do the remaining work yourself.`);
    calls.count++;
    let gate = this.turns.get(calls);
    if (!gate) this.turns.set(calls, (gate = new Semaphore(config.claudeAgentTurnConcurrency)));
    const explore = call.subagent_type === "Explore";
    // Explore always runs on the small model: reading and searching is the
    // work it is fast and cheap at. Anything else keeps the parent's model.
    const selection: Selection = explore ? EXPLORE : { ...(parent.rootSelection ?? config.selection) };
    const label = call.description.replace(/\s+/g, " ").slice(0, 80);
    const started = Date.now();
    return gate.run(() => this.all.run(async () => {
      parent.signal?.throwIfAborted();
      await parent.progress?.(`サブ: ${label}`).catch(() => {});
      const ctx = scopedContext(parent, {
        depth: 1,
        // The existing roles carry the tool boundaries: an explorer observes,
        // a worker does everything except what the user or the server sees.
        agentRole: explore ? "explorer" : "worker",
        agentSelection: selection,
        pendingImages: [],
        progress: (text) => parent.progress?.(`サブ（${label}）: ${text}`) ?? Promise.resolve(),
      });
      const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
      const date = new Date().toISOString().slice(0, 10);
      try {
        const result = await this.agent.run({
          selection,
          messages: [await subagentSystem(call.subagent_type), { role: "user", content: `${call.prompt}\n\n[date: ${date}]`, turnStart: true }],
          tools: this.tools(ctx),
          getTools: (c) => this.tools(c),
          context: ctx,
          maxRounds: config.claudeAgentRounds,
          temperature: settings.temperature,
          nativeSearch: nativeSearchFor(selection, settings.exa_mode, config.webSearch),
          execute: this.execute,
        });
        parent.recordToolUsage?.(result.usage);
        this.log?.info({ channel: parent.channelId, turn_id: parent.turnId, type: call.subagent_type, model: selection.model,
          rounds: result.rounds, usage: result.usage, latency_ms: Date.now() - started }, "Subagent completed");
        return result.text;
      } catch (error) {
        parent.signal?.throwIfAborted();
        this.log?.warn({ channel: parent.channelId, turn_id: parent.turnId, type: call.subagent_type, model: selection.model,
          error: error instanceof Error ? error.message : String(error), latency_ms: Date.now() - started }, "Subagent failed");
        throw new Error(`The subagent stopped without a report: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
}
