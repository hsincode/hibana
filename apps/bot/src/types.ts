import type { Selection } from "./config";
import type { MultiAgentSession } from "./multi-agent";
import type { WorkspaceMark } from "./workspace/types";
export type Json = Record<string, unknown>;
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type Message = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  images?: string[];
  providerBlocks?: unknown[];
  /** Local history markers; never sent as provider message fields. */
  turnStart?: boolean;
  internal?: boolean;
  /** A state note that stays in the conversation and is added again only when
   *  its state changes, so later turns keep extending the same prefix. */
  sticky?: boolean;
};
export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Json };
};
/** A tool result that is already text for the model, as the tools of an
 *  Anthropic Workspace session return it (#76). Other results are objects
 *  and are sent as JSON. */
export class ToolOutput {
  constructor(
    readonly text: string,
    readonly options: { isError?: boolean; images?: string[] } = {},
  ) {}
}
export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  // Optional: usage persisted before cache write tracking lacks it.
  cache_write_tokens?: number;
  /** Anthropic Workspace (#76): input plus output of the turn's last model
   *  request, which is how large the session's conversation has grown. The
   *  totals above add every request of a turn together and cannot tell. */
  context_tokens?: number;
};
export const emptyUsage = (): Usage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
});
export function addUsage(a: Usage, b: Usage) {
  // Iterate the full key set so an older record missing a key still sums.
  for (const k of Object.keys(emptyUsage()) as (keyof Usage)[])
    a[k] = (a[k] ?? 0) + (b[k] ?? 0);
}
export type Context = {
  guildId?: string;
  channelId: string;
  userId: string;
  botId: string;
  thread: boolean;
  messageId?: string;
  /** Names one Anthropic Workspace turn in the logs. Never sent to a provider. */
  turnId?: string;
  /** Set for a turn that runs as an Anthropic Workspace session (#76).
   *  Absent on every other turn. */
  harness?: "workspace";
  /** Workspace: set once the session accepted this turn's message, and saved
   *  with the checkpoint, so a resumed turn continues that message under the
   *  same spending ceiling instead of sending it again. */
  workspaceMark?: WorkspaceMark;
  images?: string[];
  pendingImages?: string[];
  depth: number;
  team?: MultiAgentSession;
  agentPath?: string;
  agentSelection?: Selection;
  /** Multi-Agent role of a child (explorer/worker/reviewer); absent for root and Ultra. */
  agentRole?: string;
  /** A workflow script's subagent: it returns data to the script, so it has
   *  no collaboration, Workflow or user-visible tools. */
  workflowAgent?: boolean;
  /** The user typed Claude Code's "ultracode" keyword in this turn. */
  workflowKeyword?: boolean;
  /** Opens another editable Discord message (one status line per workflow). */
  openStatus?: () => (text: string) => Promise<void>;
  delivered: boolean;
  signal?: AbortSignal;
  progress?: (text: string) => Promise<void>;
  /** A persistent notice: progress edits must not erase which evaluator ran. */
  notify?: (text: string) => Promise<void>;
  /** One Jev task message per turn; later updates edit it instead of posting again. */
  jevTaskProgress?: (text: string) => Promise<void>;
  /** Shared across plans/context copies so notice/update counts survive replanning. */
  jevExecutions?: { count: number };
  /** Correlate browser operations with the plan budget without retaining arguments. */
  jevDiagnostic?: { runId: string; deadline: number };
  /** Charge bounded evaluator calls to the active turn, including partial runs. */
  recordToolUsage?: (usage: Usage) => void;
};

// Only explicitly scoped copies inherit task ownership. Ordinary spreads used
// for new turns/subagents must not acquire the parent's home connection.
const contextTasks = new WeakMap<Context, Context>();
export const contextTask = (ctx: Context): Context => contextTasks.get(ctx) ?? ctx;
export function scopedContext(ctx: Context, overrides: Partial<Context>): Context {
  const scoped = { ...ctx, ...overrides };
  contextTasks.set(scoped, contextTask(ctx));
  return scoped;
}
