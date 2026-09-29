import {
  EFFORTS,
  MODEL_PRESETS,
  canonicalPresetId,
} from "@hibana/shared/catalog";
import { effortSchema, subagentMode } from "@hibana/shared/settings";
import { AGENT_ROLE_IDS, roleCatalogText, roleEffort, type AgentRole } from "./agent-roles";
import type { Runtime } from "./runtime";
import { recommendedEffort, type Selection } from "./config";
import type { Context, Json, Message, ToolDef } from "./types";

const tool = (
  name: string,
  description: string,
  properties: Json,
  required: string[] = [],
): ToolDef => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});
const message = { type: "string", minLength: 1, maxLength: 24000 };
const notice = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  description:
    "One Japanese sentence shown in Discord as the work line. Write Japanese even when message is English. No model id, agent path, or line breaks.",
};
const target = {
  type: "string",
  description:
    "Agent id or canonical task path. Relative names resolve beneath the calling agent.",
};
export const collaborationTools: ToolDef[] = [
  tool(
    "spawn_agent",
    "Start a subagent asynchronously and return its id and canonical task name immediately. Delegate a concrete independent task. Children can also spawn agents. Omitted model and reasoning_effort inherit the parent; user policies take precedence. Use a preset id for model to select the correct provider account. fork_turns defaults to 1 recent user turn; none starts with instructions only; all requires full-history permission. Results arrive in the mailbox, not in this call's result.",
    {
      task_name: { type: "string", pattern: "^[a-z0-9_]+$", maxLength: 64 },
      message,
      notice,
      fork_turns: {
        type: "string",
        description:
          "none, all, or a positive integer string; omitted/blank defaults to 1.",
      },
      model: { type: "string" },
      reasoning_effort: { type: "string", enum: [...EFFORTS] },
    },
    ["task_name", "message", "notice"],
  ),
  tool(
    "send_message",
    "Queue a message for an existing agent, including root or a sibling. Delivered at the next message boundary after any pending tool call. Does not start an idle agent.",
    { target, message },
    ["target", "message"],
  ),
  tool(
    "followup_task",
    "Assign another task to an existing non-root agent. Start it if idle; steer it if running. Its conversation and model selection are retained. notice replaces the Discord work line when the agent starts again.",
    { target, message, notice },
    ["target", "message", "notice"],
  ),
  tool(
    "wait_agent",
    "Wait for mailbox activity or new user input. Returns a wait summary; messages are delivered separately. Prefer waiting to repeatedly polling list_agents.",
    { timeout_ms: { type: "integer", minimum: 0, maximum: 3600000 } },
  ),
  tool(
    "interrupt_agent",
    "Interrupt an existing non-root agent and return its previous status. Context remains available for followup_task. Cannot interrupt yourself.",
    { target },
    ["target"],
  ),
  tool(
    "list_agents",
    "List agents in this task tree with their ids, canonical paths, status and last task. Other Discord tasks are never visible.",
    { path_prefix: { type: "string" } },
  ),
];
export const collaborationNames = new Set(
  collaborationTools.map((t) => t.function.name),
);

const roleProperty = (): Json => ({
  type: "string",
  enum: [...AGENT_ROLE_IDS],
  description: `Fixed Multi-Agent role. It sets the child's instructions, tool access and default effort.\n${roleCatalogText()}`,
});

/** Argument validation accepts role in every mode: Multi-Agent requires it at
 *  spawn time and Ultra ignores it, so a mode switch mid-turn cannot turn a
 *  valid call into a schema error. */
export function collaborationValidationSchema(tool: ToolDef): Json {
  const parameters = structuredClone(tool.function.parameters);
  if (tool.function.name === "spawn_agent")
    (parameters.properties as Json).role = roleProperty();
  return parameters;
}

export function selectChild(
  runtime: Runtime,
  ctx: Context,
  parent: Selection,
  args: Json,
  role?: AgentRole,
): Selection {
  const settings = runtime.resolve(ctx.guildId, ctx.userId);
  // A role override replaces the common policy for that field only; its
  // "default" keeps the common one (which may still be the agent's choice).
  const rolePolicy = role ? settings.multi_agent_roles[role] : undefined;
  const modelPolicy =
    rolePolicy && rolePolicy.model.mode !== "default" ? rolePolicy.model : settings.subagent_model;
  const effortPolicy =
    rolePolicy && rolePolicy.effort.mode !== "default" ? rolePolicy.effort : settings.subagent_effort;
  const requested =
    modelPolicy.mode === "fixed"
      ? modelPolicy.preset
      : modelPolicy.mode === "auto" && typeof args.model === "string"
        ? args.model
        : undefined;
  let selection = { ...parent };
  if (requested) {
    const id = canonicalPresetId(requested);
    const matches = MODEL_PRESETS.filter(
      (p) => p.id === id || p.model === requested,
    );
    const preset =
      matches.find((p) => p.id === id) ??
      matches.find((p) => p.provider === parent.provider) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (!preset)
      throw new Error(
        "Unknown or ambiguous subagent model; use an available preset id",
      );
    selection = { provider: preset.provider, model: preset.model };
  }
  assertChildSelection(runtime, ctx, selection);
  const changed =
    selection.provider !== parent.provider || selection.model !== parent.model;
  const inherited = changed
    ? recommendedEffort(selection.model, selection.provider)
    : parent.effort;
  // User policies and an explicit request outrank the role default; the role
  // only caps what would otherwise be inherited.
  selection.effort =
    effortPolicy.mode === "fixed"
      ? effortPolicy.effort
      : effortPolicy.mode === "same"
        ? parent.effort
        : args.reasoning_effort !== undefined
          ? effortSchema.parse(args.reasoning_effort)
          : role
            ? roleEffort(role, inherited)
            : inherited;
  return selection;
}

export function assertChildSelection(
  runtime: Runtime,
  ctx: Context,
  selection: Selection,
) {
  const preset = MODEL_PRESETS.find(
    (p) => p.provider === selection.provider && p.model === selection.model,
  );
  // Recheck on follow-ups too: a dormant agent must not retain a revoked plan
  // or access to an account whose credentials were removed after spawning.
  // ChatGPT uses API-managed OAuth credentials, not an endpoint API key.
  // Share the catalog/root availability check or inherited ChatGPT children
  // are incorrectly rejected before their first model request.
  if (
    !runtime.providerAvailable(selection.provider) ||
    (preset && !runtime.canSelect(preset.id, ctx.userId))
  )
    throw new Error("Subagent model is unavailable for your account");
}

export function teamTools(runtime: Runtime, ctx: Context): ToolDef[] {
  const settings = runtime.resolve(ctx.guildId, ctx.userId);
  const multi = subagentMode(settings) === "multi";
  return collaborationTools.map((t) => {
    if (t.function.name !== "spawn_agent") return t;
    const copy = structuredClone(t);
    const properties = copy.function.parameters.properties as Json;
    // Ultra keeps the HsinCLI schema unchanged; only Multi-Agent adds roles.
    if (multi) {
      properties.role = roleProperty();
      (copy.function.parameters.required as string[]).push("role");
      copy.function.description += " Multi-Agent mode: role is required and only the orchestrator (root) can spawn.";
    }
    if (settings.subagent_model.mode !== "auto") delete properties.model;
    if (settings.subagent_effort.mode !== "auto")
      delete properties.reasoning_effort;
    // Role overrides win over the common policy and over model/reasoning_effort
    // arguments for that role; stating them avoids futile model requests.
    const roleOverrides = multi
      ? Object.fromEntries(Object.entries(settings.multi_agent_roles).filter(
        ([, p]) => p.model.mode !== "default" || p.effort.mode !== "default"))
      : {};
    copy.function.description += ` Model policy: ${JSON.stringify(settings.subagent_model)}. Effort policy: ${JSON.stringify(settings.subagent_effort)}.${Object.keys(roleOverrides).length ? ` Per-role overrides (take precedence for that role): ${JSON.stringify(roleOverrides)}.` : ""} Available model presets: ${MODEL_PRESETS.filter(
      (p) => runtime.canSelect(p.id, ctx.userId),
    )
      .map((p) => p.id)
      .join(
        ", ",
      )}. Full-history allowed: ${runtime.config.subagentForkAllowAll && !runtime.config.subagentForkMaxTurns}. Numeric fork limit: ${runtime.config.subagentForkMaxTurns ?? "none"}.`;
    return copy;
  });
}

/** Fork complete user turns, never an orphan tool output or provider-encrypted block. */
export function forkMessages(
  messages: Message[],
  requested: unknown,
  runtime: Runtime,
): Message[] {
  const fork =
    typeof requested === "string" && requested.trim() ? requested.trim() : "1";
  const max = runtime.config.subagentForkMaxTurns;
  if (fork === "all" && (!runtime.config.subagentForkAllowAll || max))
    throw new Error(
      "Full-history forks are disabled by the configured history policy",
    );
  if (
    fork !== "none" &&
    fork !== "all" &&
    (!/^[1-9][0-9]*$/.test(fork) ||
      !Number.isSafeInteger(Number(fork)) ||
      (max && Number(fork) > max))
  )
    throw new Error(
      "fork_turns must be none, all, or a permitted positive integer string",
    );
  // Role, orchestrator-protocol and triage notes address one specific agent.
  // A child gets its own role message instead of inheriting root's.
  const agentScoped = (m: Message) =>
    /^<multi_agent_(role|team|triage)>/.test(m.content ?? "");
  const instructions = messages
    .filter(
      (m) =>
        m.role === "system" ||
        m.role === "developer" ||
        m.content?.startsWith("# AGENTS.md instructions"),
    )
    .filter((m) => !agentScoped(m));
  const conversation = messages.filter(
    (m) => !instructions.includes(m) && !agentScoped(m),
  );
  const marked = conversation.some((m) => m.turnStart);
  const starts = conversation.flatMap((m, i) =>
    (marked ? m.turnStart : m.role === "user" && !m.internal) ? [i] : [],
  );
  const start = starts[Math.max(0, starts.length - Number(fork))] ?? 0;
  const history =
    fork === "none"
      ? []
      : fork === "all"
        ? conversation
        : conversation.slice(start);
  return repairHistory(structuredClone([...instructions, ...history]));
}

export function repairHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const { providerBlocks, reasoning_content, ...message } = messages[i]!;
    if (message.role === "tool") continue;
    out.push(message);
    for (const call of message.tool_calls ?? []) {
      // A fork can occur halfway through a parent tool batch. Close that batch
      // explicitly instead of sending an invalid assistant/tool sequence.
      const result = messages
        .slice(i + 1)
        .find((m) => m.role === "tool" && m.tool_call_id === call.id);
      out.push(
        result ?? {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            interrupted: true,
            message:
              "Result unavailable at this history boundary; check actual state before retrying.",
          }),
        },
      );
    }
  }
  return out;
}
