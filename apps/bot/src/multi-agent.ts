import { MODEL_PRESETS } from "@hibana/shared/catalog";
import { subagentMode } from "@hibana/shared/settings";
import type { Logger } from "pino";
import {
  AGENT_ROLES,
  FINAL_REVIEW_NOTICE,
  FINAL_REVIEW_REVISION,
  FINAL_REVIEW_TIMEOUT_MS,
  finalReviewTask,
  finalReviewVerdict,
  isAgentRole,
  type AgentRole,
} from "./agent-roles";
import {
  EXPLORER_PRESTART_NOTICE,
  EXPLORER_PRESTART_TASK,
  REVIEW_THRESHOLD,
  shouldPrestartExplorer,
  triageHint,
  type Triage,
} from "./jev-triage";
import type { Agent, AgentOptions, AgentResult } from "./agent";
import type { Runtime } from "./runtime";
import type { Selection } from "./config";
import { nativeSearchFor } from "./llm";
import {
  addUsage,
  emptyUsage,
  type Context,
  type Json,
  type Message,
  type ToolDef,
  type Usage,
} from "./types";
import {
  assertChildSelection,
  forkMessages,
  repairHistory,
  selectChild,
} from "./multi-agent-policy";
import { WorkflowJournals, WorkflowManager, type WorkflowFiles } from "./workflow/manager";

// Spawn messages may be 24k. The channel notice keeps one short line, same
// budget as Jev status details, so two workers do not each dump a prompt.
const SUBAGENT_TASK_LINE = 160;

/** Product name from the catalog label ("Codex Plus / GPT-6 Luna" → "GPT 6 Luna").
 *  Hyphens become spaces because the Discord notice is a label, not a wire id. */
export function subagentModelTitle(selection: Selection): string {
  const preset = MODEL_PRESETS.find(
    (p) => p.provider === selection.provider && p.model === selection.model,
  );
  const labeled = preset?.label.split("/").slice(1).join("/").trim();
  if (labeled) return labeled.replaceAll("-", " ");
  return selection.model
    .split("-")
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : /^\d/.test(part)
          ? part
          : part.slice(0, 1).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

export function oneLineTask(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= SUBAGENT_TASK_LINE
    ? line
    : `${line.slice(0, SUBAGENT_TASK_LINE - 1)}…`;
}

// The parent writes `message` in English. Discord shows `notice` instead, so
// reject a line with no kana or kanji before the channel post is sent.
const JAPANESE_WORK = /[\u3040-\u30ff\u3400-\u9fff]/;

export function subagentNoticeLine(value: unknown): string {
  const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!line || line.length > SUBAGENT_TASK_LINE || !JAPANESE_WORK.test(line))
    throw new Error(
      "notice must be one Japanese line of at most 160 characters describing the work",
    );
  return line;
}

/** Discord label; a Multi-Agent role shows as `サブエージェント（調査）`. */
export function subagentLabel(selection: Selection, role?: AgentRole): string {
  return `サブエージェント${role ? `（${AGENT_ROLES[role].label}）` : ""}: ${subagentModelTitle(selection)}`;
}

export function formatSubagentStartNotice(
  selection: Selection,
  task: string,
  role?: AgentRole,
): string {
  return `${subagentLabel(selection, role)}\n${oneLineTask(task)}`;
}

export type TriageRunner = (
  ctx: Context,
  messages: readonly Message[],
) => Promise<{ triage: Triage; usage: Usage } | undefined>;

type Member = {
  id: string;
  path: string;
  parent?: string;
  selection: Selection;
  /** Multi-Agent role; undefined for root and every Ultra child. */
  role?: AgentRole;
  context: Context;
  messages: Message[];
  mailbox: Message[];
  status: "running" | "completed" | "interrupted" | "errored";
  /** Latest final answer; the review gate reads the reviewer's verdict here. */
  result?: string;
  lastTask: string;
  /** Japanese one-liner posted to Discord. Distinct from the full task message. */
  notice: string;
  controller: AbortController;
  running?: Promise<void>;
  restart: boolean;
  wake: Set<() => void>;
};

/** One Discord task owns one tree: no global agent ids or mailboxes cross users. */
export class MultiAgentSession {
  private members = new Map<string, Member>();
  private closed = false;
  private childUsage = emptyUsage();
  private rootOptions!: AgentOptions;
  private triageResult?: Triage;
  /** One runtime review per Discord turn bounds the added latency. */
  private reviewed = false;
  /** Background Workflow runs of this turn (Claude Code dynamic workflows). */
  private workflows?: WorkflowManager;
  /** Root output tokens, for the workflow budget.spent() pool. */
  private rootOutput = 0;
  constructor(
    private readonly runtime: Runtime,
    private readonly agent: Agent,
    private readonly tools: (ctx: Context) => ToolDef[],
    // Omitted on /retry resumes so a checkpoint does not restart research
    // that the previous attempt may already have finished.
    private readonly options: {
      triage?: TriageRunner;
      log?: Logger;
      /** Tests shorten the review deadline; production uses the default. */
      reviewTimeoutMs?: number;
      /** Resume journals outlive the turn; files reach the task's workspace. */
      workflows?: { journals: WorkflowJournals; files?: WorkflowFiles };
    } = {},
  ) {}

  async runRoot(options: AgentOptions): Promise<AgentResult> {
    this.rootOptions = options;
    const originalSignal = options.context.signal;
    const root = this.member(
      "/root",
      options.selection,
      options.context,
      options.messages,
    );
    // Role and triage notes describe one live tree; stale copies from history
    // or a checkpoint would point the model at agents that no longer exist.
    // Root's own role note is the same every turn, so the copy already in
    // history stays where it was sent.
    const role = this.roleMessage(root);
    const messages = options.messages.filter(
      (m) => m.content === role.content || !/^<multi_agent_(role|triage)>/.test(m.content ?? ""),
    );
    // Standing notes stay in history and are added again only when missing.
    // Appending them on every turn would put them between the previous turn's
    // user message and its answer, so no turn could extend the last request.
    const standing: Message[] = [
      { ...role, sticky: true },
      {
        role: "developer",
        internal: true,
        sticky: true,
        content:
          "Each user turn starts a fresh agent tree. Agent paths mentioned in earlier turns or checkpoints are historical; use spawn_agent for new live agents. Workflow runs from earlier turns are no longer running; relaunch one with resumeFromRunId to reuse its completed agents.",
      },
    ];
    root.messages = [
      ...messages,
      ...standing.filter((note) => !messages.some((m) => m.content === note.content)),
    ];
    this.workflows = new WorkflowManager({
      root: () => ({ context: root.context, selection: options.selection, messages: root.messages }),
      options: () => this.rootOptions,
      notify: (content) => {
        if (this.closed) return;
        if (root.mailbox.length >= 128) root.mailbox.shift();
        root.mailbox.push({ role: "user", internal: true, content });
        for (const wake of root.wake) wake();
      },
      wake: () => { for (const wake of root.wake) wake(); },
      recordUsage: (usage) => addUsage(this.childUsage, usage),
      spent: () => this.rootOutput + this.childUsage.completion_tokens,
    }, {
      runtime: this.runtime,
      agent: this.agent,
      tools: this.tools,
      journals: this.options.workflows?.journals ?? new WorkflowJournals(),
      files: this.options.workflows?.files,
      log: this.options.log,
    });
    try {
      const hint = this.options.triage ? await this.triage(root) : undefined;
      if (hint) root.messages.push(hint);
      const result = await this.agent.run({
        ...options,
        messages: root.messages,
        tools: this.tools(root.context),
        context: root.context,
        observeMessages: (messages) => {
          root.messages = messages;
        },
        recordUsage: (usage) => {
          this.rootOutput += usage.completion_tokens;
          options.recordUsage?.(usage);
        },
        takeSteering: () => [
          ...(options.takeSteering?.() ?? []),
          ...this.drain(root),
        ],
        beforeFinal: async (candidate) => {
          // Claude Code ends the turn and answers when the <task-notification>
          // arrives. A Discord reply cannot be sent twice, so root waits here
          // for its background workflows instead of polling; new user input
          // still interrupts the wait.
          while (!root.mailbox.length && this.workflows?.running()) {
            const waited = await this.wait(root, 3_600_000, options.requestSignal?.());
            if (waited.message === "Wait interrupted by new input.") break;
          }
          if (!root.mailbox.length && this.activeChildren())
            await this.wait(root, 30000, options.requestSignal?.());
          const pending = this.drain(root);
          if (!pending.length && this.activeChildren())
            pending.push({
              role: "developer",
              internal: true,
              content:
                "Subagents are still active. Collect their results or interrupt unnecessary work before delivering the final answer.",
            });
          if (pending.length) return pending;
          return this.reviewGate(root, candidate ?? "", options.requestSignal?.());
        },
      });
      addUsage(result.usage, this.childUsage);
      return result;
    } finally {
      await this.close();
      delete options.context.team;
      delete options.context.agentPath;
      delete options.context.agentSelection;
      delete options.context.agentRole;
      options.context.signal = originalSignal;
    }
  }

  private member(
    path: string,
    selection: Selection,
    parentContext: Context,
    messages: Message[],
    parent?: string,
    role?: AgentRole,
  ): Member {
    const controller = new AbortController();
    // All members share the same authorized workspace identity; cancellation is
    // per member plus the root task, never inherited from a sibling's interrupt.
    const rootSignal = this.rootOptions.context.signal;
    const member: Member = {
      id: crypto.randomUUID(),
      path,
      parent,
      selection,
      role,
      messages,
      mailbox: [],
      status: "running",
      lastTask: "",
      notice: "",
      controller,
      restart: false,
      wake: new Set(),
      context: {
        ...parentContext,
        depth: parent ? parentContext.depth + 1 : 0,
        team: this,
        agentPath: path,
        agentSelection: selection,
        // Set explicitly so a child never inherits another member's role.
        agentRole: role,
        pendingImages: [],
        delivered: parent ? false : parentContext.delivered,
        signal: rootSignal
          ? AbortSignal.any([rootSignal, controller.signal])
          : controller.signal,
      },
    };
    // Home connection ownership uses object identity. Keep the root Context
    // itself so the transport's finally block can always revoke its connection.
    if (!parent) member.context = Object.assign(parentContext, member.context);
    if (parent)
      member.context.progress = (text) =>
        this.rootOptions.context.progress?.(
          `${subagentLabel(selection, role)}\n${text}`,
        ) ?? Promise.resolve();
    this.members.set(path, member);
    return member;
  }

  private roleMessage(member: Member): Message {
    // Ultra children keep the HsinCLI V2 wording. A Multi-Agent role child
    // gets narrower coordination rights and its role brief instead.
    const role = member.role ? AGENT_ROLES[member.role] : undefined;
    const coordination = role
      ? "All agents share the authorized /workspace filesystem. As a Multi-Agent role child you may message the orchestrator or siblings, wait for mailbox updates and list agents; only the orchestrator (/root) spawns agents, assigns follow-up tasks or interrupts work. Use agents__send_message, agents__wait_agent, agents__list_agents."
      : "All agents share the authorized /workspace filesystem and may spawn children, message siblings or parents, assign follow-up tasks, wait for mailbox updates, list agents, and interrupt unnecessary work. Use agents__spawn_agent, agents__send_message, agents__followup_task, agents__wait_agent, agents__list_agents, agents__interrupt_agent. spawn_agent and followup_task require notice: one Japanese sentence shown to the user. message is the full task and is not shown in Discord.";
    const finish = role
      ? `${role.instructions} Your final answer is an internal report to the orchestrator, not a message to the user: the user never sees it directly, so include everything the orchestrator needs to deliver. If the assignment needs splitting, is blocked, or needs a tool your role lacks, tell the orchestrator with agents__send_message.`
      : member.parent
        ? "Your final answer is delivered to your parent; finish only your assigned task."
        : "Integrate child results and deliver the user's complete result.";
    const tools = role
      ? "Your tools are limited to your role, subject to existing Discord permission checks and root-only home connection controls."
      : "Children have the same tools subject to existing Discord permission checks and root-only home connection controls.";
    return {
      role: "developer",
      internal: true,
      content: `<multi_agent_role>You are ${member.path}, ${member.parent ? `a subagent assigned by ${member.parent}` : "the primary agent"} in a team collaborating on the user's task. multi_agent_v2=true. ${coordination} Relative targets resolve beneath your own path; use canonical paths for siblings or ancestors. Messages arrive at message boundaries as MESSAGE, NEW_TASK or FINAL_ANSWER. send_message does not start an idle agent; followup_task does. ${finish} The tree has ${this.runtime.config.subagentConcurrency + 1} concurrent slots including root; idle agents release their slot. A waiting turn still occupies its slot. ${tools} Model and effort policies apply to every descendant. Do not infer permission for external messages from inter-agent messaging tools.</multi_agent_role>`,
    };
  }

  /** Jev triage before root's first request: returns a hint and may pre-start
   *  an explorer so research overlaps the orchestrator's planning call. */
  private async triage(root: Member): Promise<Message | undefined> {
    const outcome = await this.options.triage!(root.context, root.messages);
    if (!outcome) return undefined;
    addUsage(this.childUsage, outcome.usage);
    this.triageResult = outcome.triage;
    let prestarted: string | undefined;
    if (shouldPrestartExplorer(outcome.triage)) {
      try {
        // Same path as a model call: slot limit, model/effort policy, role
        // tools and the start notice all apply to the pre-started explorer.
        const started = (await this.execute(
          "spawn_agent",
          {
            task_name: "explorer",
            role: "explorer",
            message: EXPLORER_PRESTART_TASK,
            notice: EXPLORER_PRESTART_NOTICE,
          },
          root.context,
        )) as { task_name: string };
        prestarted = started.task_name;
      } catch {
        // e.g. the subagent model became unavailable: plan without it.
      }
    }
    return {
      role: "developer",
      internal: true,
      content: `<multi_agent_triage>${triageHint(outcome.triage, prestarted)}</multi_agent_triage>`,
    };
  }

  /** Multi-Agent quality gate at root's stop boundary. The first production
   *  runs never reached a reviewer when the orchestrator was only told to use
   *  one, so the runtime starts it: after a worker produced output, or when Jev
   *  expects review to matter (any child run counts when triage is absent). */
  private async reviewGate(
    root: Member,
    candidate: string,
    steering?: AbortSignal,
  ): Promise<Message[]> {
    if (this.reviewed || !candidate) return [];
    const settings = this.runtime.resolve(root.context.guildId, root.context.userId);
    if (subagentMode(settings) !== "multi") return [];
    const children = [...this.members.values()].filter((m) => m.parent);
    // The orchestrator already had a review this turn; do not add a second.
    if (children.some((m) => m.role === "reviewer" && m.status === "completed"))
      return [];
    const trigger = children.some((m) => m.role === "worker")
      ? "worker"
      : this.triageResult
        ? this.triageResult.needs_review >= REVIEW_THRESHOLD ? "triage" : undefined
        : children.length ? "children" : undefined;
    if (!trigger) return [];
    this.reviewed = true;
    const started = performance.now();
    let verdict = "error";
    let reviewer: Member | undefined;
    // Reports from the reviewer are consumed here; anything else still goes
    // back to the orchestrator through the normal mailbox path.
    const takeOthers = () => {
      const own = (m: Message) =>
        !!reviewer && !!m.content?.includes(`\nSender: ${reviewer.path}\nPayload:`);
      const all = this.drain(root);
      return { own: all.filter(own), others: all.filter((m) => !own(m)) };
    };
    try {
      let name = "final_review";
      for (let i = 2; this.members.has(`/root/${name}`); i++) name = `final_review_${i}`;
      const { task_name } = (await this.execute(
        "spawn_agent",
        { task_name: name, role: "reviewer", message: finalReviewTask(candidate), notice: FINAL_REVIEW_NOTICE },
        root.context,
      )) as { task_name: string };
      reviewer = this.members.get(task_name)!;
      const outcome = await this.settle(
        reviewer,
        this.options.reviewTimeoutMs ?? FINAL_REVIEW_TIMEOUT_MS,
        steering,
      );
      if (outcome !== "done") {
        // Deliver the unreviewed candidate rather than stall the turn; new
        // user input is handled by the agent loop right after this returns.
        verdict = outcome;
        reviewer.restart = false;
        reviewer.controller.abort(new Error(outcome === "timeout" ? "Review timed out" : "Superseded by new input"));
        await reviewer.running;
        return takeOthers().others;
      }
      const { own, others } = takeOthers();
      if (reviewer.status !== "completed") {
        verdict = reviewer.status;
        return others;
      }
      verdict = finalReviewVerdict(reviewer.result ?? "");
      if (verdict === "pass") return others;
      return [...others, ...own, { role: "developer", internal: true, content: FINAL_REVIEW_REVISION }];
    } catch {
      // e.g. slots or the subagent model became unavailable: deliver as is.
      return reviewer ? takeOthers().others : [];
    } finally {
      // No candidate text or review body: only the decision and its cost.
      this.options.log?.info({
        channel: root.context.channelId, message_id: root.context.messageId,
        trigger, verdict, elapsed_ms: Math.round(performance.now() - started),
      }, "Multi-Agent review finished");
    }
  }

  /** Wait for one member's run, bounded by a deadline and user steering. */
  private settle(
    member: Member,
    timeout: number,
    steering?: AbortSignal,
  ): Promise<"done" | "timeout" | "steered"> {
    const running = member.running;
    if (!running) return Promise.resolve("done");
    if (steering?.aborted) return Promise.resolve("steered");
    return new Promise((resolve) => {
      const finish = (value: "done" | "timeout" | "steered") => {
        clearTimeout(timer);
        steering?.removeEventListener("abort", steer);
        resolve(value);
      };
      const steer = () => finish("steered");
      const timer = setTimeout(() => finish("timeout"), timeout);
      steering?.addEventListener("abort", steer, { once: true });
      // start() catches every failure, so this promise only resolves.
      void running.then(() => finish("done"));
    });
  }

  private activeChildren() {
    return [...this.members.values()].filter(
      (m) => m.path !== "/root" && m.running,
    ).length;
  }
  private checkSlot() {
    if (this.activeChildren() >= this.runtime.config.subagentConcurrency)
      throw new Error(
        "All agent slots are occupied. Wait for completion or interrupt an agent before starting more work.",
      );
  }
  private resolve(caller: Member, target: unknown) {
    if (typeof target !== "string") throw new Error("Agent target is required");
    const member =
      this.members.get(
        target.startsWith("/") ? target : `${caller.path}/${target}`,
      ) ?? [...this.members.values()].find((m) => m.id === target);
    if (!member) throw new Error("Agent not found in this task tree");
    return member;
  }
  private enqueue(target: Member, sender: Member, kind: string, text: string) {
    // Bound retained cross-agent text independently of the model's tool budget.
    if (target.mailbox.length >= 128)
      throw new Error(
        "Agent mailbox is full; wait for the recipient to consume messages",
      );
    target.mailbox.push({
      role: "user",
      internal: true,
      content: `Message Type: ${kind}\nTask name: ${target.path}\nSender: ${sender.path}\nPayload:\n${text.slice(0, 24000)}`,
    });
    for (const wake of target.wake) wake();
  }
  private drain(member: Member) {
    return member.mailbox.splice(0);
  }

  async execute(name: string, args: Json, context: Context): Promise<unknown> {
    if (this.closed || context.team !== this)
      throw new Error("Agent task is no longer active");
    const caller = this.members.get(context.agentPath ?? "");
    if (!caller || caller.context !== context)
      throw new Error("Invalid agent context");
    context.signal?.throwIfAborted();
    if (name === "list_agents") {
      const prefix =
        args.path_prefix === undefined ? "/root" : String(args.path_prefix);
      const agents = [...this.members.values()]
        .filter((m) => m.path === prefix || m.path.startsWith(prefix + "/"))
        .map((m) => ({
          agent_id: m.id,
          task_name: m.path,
          parent: m.parent ?? null,
          role: m.role ?? null,
          status: m.status,
          last_task_message: m.lastTask.slice(0, 1000),
          model: m.selection.model,
          provider: m.selection.provider,
          reasoning_effort: m.selection.effort,
        }));
      // Leave room for the envelope within Agent's tool-result budget. Cutting
      // the serialized JSON mid-member would hide even the usable agent ids.
      const total = agents.length;
      while (agents.length && JSON.stringify(agents).length > 30000)
        agents.pop();
      return {
        agents,
        omitted: total - agents.length,
        ...(agents.length < total
          ? { hint: "Narrow path_prefix to inspect omitted agents." }
          : {}),
      };
    }
    if (name === "wait_agent") {
      const ms =
        args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
      if (!Number.isInteger(ms) || ms < 0 || ms > 3600000)
        throw new Error("Invalid wait timeout");
      return this.wait(
        caller,
        Math.max(10000, ms),
        caller.path === "/root"
          ? this.rootOptions.requestSignal?.()
          : undefined,
      );
    }
    if (name === "spawn_agent") {
      if (
        typeof args.task_name !== "string" ||
        !/^[a-z0-9_]{1,64}$/.test(args.task_name)
      )
        throw new Error("Invalid task_name");
      const text = this.message(args.message);
      const work = subagentNoticeLine(args.notice);
      // Read the live setting: a mode switch mid-turn applies to new spawns.
      const multi =
        subagentMode(this.runtime.resolve(context.guildId, context.userId)) === "multi";
      if (multi && caller.path !== "/root")
        throw new Error(
          "In Multi-Agent mode only the orchestrator starts agents; ask it with agents__send_message",
        );
      if (multi && !isAgentRole(args.role))
        throw new Error("role must be explorer, worker or reviewer in Multi-Agent mode");
      // Ultra ignores a stray role so its children keep every tool.
      const role = multi ? (args.role as AgentRole) : undefined;
      const path = `${caller.path}/${args.task_name}`;
      if (this.members.has(path))
        throw new Error("Task name already exists; use followup_task");
      this.checkSlot();
      // Dormant agents retain histories; cap retained members to bound per-task
      // memory even when a model repeatedly spawns and finishes tiny tasks.
      if (this.members.size >= 128)
        throw new Error(
          "Task agent history limit reached; reuse an existing agent",
        );
      const selection = selectChild(
        this.runtime,
        context,
        caller.selection,
        args,
        role,
      );
      const messages = forkMessages(
        caller.messages,
        args.fork_turns,
        this.runtime,
      );
      const child = this.member(
        path,
        selection,
        context,
        messages,
        caller.path,
        role,
      );
      child.messages.push(this.roleMessage(child));
      child.lastTask = text;
      child.notice = work;
      this.enqueue(child, caller, "NEW_TASK", text);
      this.start(child);
      return { agent_id: child.id, task_name: path };
    }
    const recipient = this.resolve(caller, args.target);
    if (name === "interrupt_agent") {
      if (recipient.path === "/root" || recipient === caller)
        throw new Error("Cannot interrupt root or yourself");
      const previous_status = recipient.status;
      recipient.restart = false;
      // The reason reaches the parent's mailbox and the Stop check's evidence.
      // A bare "interrupted" read as unfinished work: in production Jev
      // rejected an Ultra answer three times after root stopped idle workers.
      recipient.controller.abort(new Error(
        `Stopped on purpose by ${caller.path}; this assignment is no longer needed and is not unfinished user work`,
      ));
      if (!recipient.running) recipient.status = "interrupted";
      return { previous_status };
    }
    if (name === "send_message" || name === "followup_task") {
      const text = this.message(args.message);
      const followup = name === "followup_task";
      if (followup && recipient.path === "/root")
        throw new Error("Follow-up tasks cannot target root");
      // Reject a non-Japanese notice before taking a slot or queueing the task.
      const work = followup ? subagentNoticeLine(args.notice) : "";
      if (followup && !recipient.running) this.checkSlot();
      this.enqueue(recipient, caller, followup ? "NEW_TASK" : "MESSAGE", text);
      if (followup) {
        recipient.lastTask = text;
        recipient.notice = work;
        if (!recipient.running) this.start(recipient);
        else if (recipient.controller.signal.aborted) recipient.restart = true;
      }
      return { queued: true, task_name: recipient.path };
    }
    throw new Error("Unknown collaboration tool");
  }
  private message(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.length > 24000)
      throw new Error("Message must contain 1–24000 characters");
    return value;
  }

  private start(member: Member) {
    member.controller = new AbortController();
    const rootSignal = this.rootOptions.context.signal;
    member.context.signal = rootSignal
      ? AbortSignal.any([rootSignal, member.controller.signal])
      : member.controller.signal;
    member.status = "running";
    member.restart = false;
    // Reserve the slot synchronously before any notification/network await.
    member.running = Promise.resolve().then(async () => {
      try {
        member.context.signal?.throwIfAborted();
        assertChildSelection(this.runtime, member.context, member.selection);
        // A shared progress edit can vanish before a user sees the worker.
        // Keep one start notice per run, like Jev's independent notice.
        // The path and wire id are for the model; the channel shows the
        // product name and the Japanese notice, not the full task message.
        const notice = formatSubagentStartNotice(
          member.selection,
          member.notice,
          member.role,
        );
        if (member.context.notify) await member.context.notify(notice);
        else await member.context.progress?.(oneLineTask(member.notice));
        const result = await this.agent.run({
          ...this.rootOptions,
          selection: member.selection,
          context: member.context,
          messages: repairHistory(member.messages),
          tools: this.tools(member.context),
          checkpoint: undefined,
          requestSignal: undefined,
          nativeSearch: nativeSearchFor(
            member.selection,
            this.runtime.resolve(member.context.guildId, member.context.userId)
              .exa_mode,
            this.runtime.config.webSearch,
          ),
          observeMessages: (messages) => {
            member.messages = messages;
          },
          recordUsage: (usage) => addUsage(this.childUsage, usage),
          takeSteering: () => this.drain(member),
          beforeFinal: async () => {
            const active = () =>
              [...this.members.values()].some(
                (m) => m.path.startsWith(member.path + "/") && m.running,
              );
            if (!member.mailbox.length && active())
              await this.wait(member, 30000);
            const pending = this.drain(member);
            if (!pending.length && active())
              pending.push({
                role: "developer",
                internal: true,
                content:
                  "Your descendants are still active. Collect their results or interrupt unnecessary work before returning to your parent.",
              });
            return pending;
          },
        });
        member.status = "completed";
        member.result = result.text;
        this.notifyParent(member, "FINAL_ANSWER", result.text);
      } catch (error) {
        member.status = member.controller.signal.aborted
          ? "interrupted"
          : "errored";
        this.notifyParent(
          member,
          "MESSAGE",
          `${member.status}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (member.context.delivered) {
          // A grandchild's successful delivery also satisfies its parent's
          // delivery check; otherwise the parent may resend the same artifact.
          let ancestor = this.members.get(member.parent!);
          while (ancestor) {
            ancestor.context.delivered = true;
            ancestor = ancestor.parent
              ? this.members.get(ancestor.parent)
              : undefined;
          }
        }
        member.running = undefined;
        if (member.restart && !this.closed && !rootSignal?.aborted)
          this.start(member);
        for (const wake of this.members.get("/root")!.wake) wake();
      }
    });
  }
  private notifyParent(member: Member, kind: string, content: string) {
    if (this.closed) return;
    const parent = this.members.get(member.parent!)!;
    // Completion must not become an unhandled rejection when a mailbox fills.
    // Keep a final result by replacing the oldest queued communication.
    if (parent.mailbox.length >= 128) parent.mailbox.shift();
    this.enqueue(parent, member, kind, content);
  }

  private async wait(
    member: Member,
    timeout: number,
    steeringSignal?: AbortSignal,
  ) {
    if (member.mailbox.length)
      return { message: "Wait completed.", timed_out: false };
    member.context.signal?.throwIfAborted();
    if (steeringSignal?.aborted)
      return { message: "Wait interrupted by new input.", timed_out: false };
    return new Promise<{ message: string; timed_out: boolean }>(
      (resolve, reject) => {
        const finish = (
          message: string,
          timed_out = false,
          error?: unknown,
        ) => {
          clearTimeout(timer);
          member.wake.delete(wake);
          member.context.signal?.removeEventListener("abort", abort);
          steeringSignal?.removeEventListener("abort", steer);
          if (error) reject(error);
          else resolve({ message, timed_out });
        };
        const wake = () => finish("Wait completed.");
        const abort = () =>
          finish(
            "",
            false,
            member.context.signal?.reason ?? new Error("Aborted"),
          );
        const steer = () => finish("Wait interrupted by new input.");
        const timer = setTimeout(
          () => finish("Wait timed out.", true),
          timeout,
        );
        member.wake.add(wake);
        member.context.signal?.addEventListener("abort", abort, { once: true });
        steeringSignal?.addEventListener("abort", steer, { once: true });
      },
    );
  }
  /** Workflow tool (root only): start a background workflow run. */
  async launchWorkflow(args: Json, context: Context): Promise<unknown> {
    this.assertRoot(context);
    return this.workflows!.launch(args, context);
  }

  /** TaskStop tool (root only): stop a running workflow of this turn. */
  stopTask(args: Json, context: Context): unknown {
    this.assertRoot(context);
    return this.workflows!.stop(args, context);
  }

  private assertRoot(context: Context) {
    if (this.closed || context.team !== this || !this.workflows)
      throw new Error("Agent task is no longer active");
    const caller = this.members.get(context.agentPath ?? "");
    if (!caller || caller.context !== context || caller.path !== "/root")
      throw new Error("Only the main agent can run workflows");
  }

  async close() {
    this.closed = true;
    for (const member of this.members.values())
      member.controller.abort(new Error("Task finished"));
    // Workflow agents share the workspace lease like members: wait for them.
    await Promise.allSettled([
      ...(this.workflows ? [this.workflows.close()] : []),
      ...[...this.members.values()].flatMap((m) => (m.running ? [m.running] : [])),
    ]);
    this.members.clear();
  }
}
