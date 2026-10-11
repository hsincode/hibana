import type { ServiceTier } from "@hibana/shared/settings";
import { LlmClient } from "./llm";
import { failureDetail, ProviderError } from "./llm-errors";
import { statusLine, stripThinking } from "./claude/progress";
import { resultText } from "./claude/tools";
import type { Selection } from "./config";
import { jevTaskModeIn, jevTaskModeMessage } from "./jev-task";
import { Serial } from "./io";
import { runToolBatch, supportsParallelTool } from "./tool-concurrency";
import {
  addUsage,
  emptyUsage,
  scopedContext,
  ToolOutput,
  type Context,
  type Message,
  type ToolDef,
  type Usage,
} from "./types";
export type AgentResult = {
  text: string;
  messages: Message[];
  usage: Usage;
  rounds: number;
  /** Input plus output tokens of the last request: how long the conversation
   *  is now. `usage` adds every request of the run together. */
  context: number;
};
export type AgentOptions = {
  selection: Selection;
  messages: Message[];
  tools: ToolDef[];
  getTools?: (ctx: Context) => ToolDef[];
  jevTaskMode?: (ctx: Context) => boolean;
  context: Context;
  maxRounds: number;
  serviceTier?: ServiceTier;
  temperature: number;
  nativeSearch: boolean;
  execute: (
    name: string,
    args: Record<string, unknown>,
    ctx: Context,
  ) => Promise<unknown>;
  observeMessages?: (messages: Message[]) => void;
  recordUsage?: (usage: Usage) => void;
  /** Runs at the stop boundary with the candidate answer; returned messages
   *  continue the loop (worker results, the Multi-Agent review gate). */
  beforeFinal?: (candidate?: string) => Promise<Message[]>;
  checkpoint?: (messages: Message[], usage: Usage) => Promise<void>;
  takeSteering?: () => Message[];
  requestSignal?: () => AbortSignal | undefined;
  /** Ends the loop without another model call, e.g. once a workflow agent's
   *  StructuredOutput call has been accepted (its answer is that call). */
  shouldStop?: () => boolean;
  /** Claude harness: thinking blocks were removed from `messages` because the
   *  API rejected them; the caller removes them from stored history as well. */
  onThinkingStripped?: () => void;
};
export class Agent {
  constructor(readonly llm: LlmClient) {}
  async run(o: AgentOptions): Promise<AgentResult> {
    const messages = structuredClone(o.messages),
      usage = emptyUsage(),
      seen = new Map<string, number>();
    o.observeMessages?.(messages);
    // Names one request chain in the usage log. A child gets a random id per
    // run: its path carries a model-chosen task name, which must not be logged.
    const lineage = o.context.depth === 0 ? "root"
      : `${o.context.workflowAgent ? "workflow" : "child"}-${crypto.randomUUID().slice(0, 8)}`;
    // The note stays in history, so a turn repeats it only when the mode
    // changed. Re-sending it every turn would split each turn from the last.
    let lastTaskMode = jevTaskModeIn(messages);
    let nudges = 0;
    // The Claude harness (#66) differs from here on in how a tool result is
    // written, what counts as a repeated call and how a status line is found.
    const claude = o.context.harness === "claude";
    let previousCall = "", streak = 0, stripped = false, context = 0;
    // The soft budget is refilled once, matching the original loop's completion guarantee.
    const hardLimit = o.context.team || o.context.depth === 0 ? 512 : o.maxRounds;
    for (let round = 0; round < hardLimit; round++) {
      o.context.signal?.throwIfAborted();
      const steer = o.takeSteering?.() ?? [];
      if (steer.length) messages.push(...steer);
      const taskMode = o.jevTaskMode?.(o.context) ?? false;
      if (o.jevTaskMode && taskMode !== lastTaskMode) {
        // Re-read at each planning boundary for live settings. A checkpoint
        // drops developer notes, so a resumed task is told an active mode again.
        messages.push(jevTaskModeMessage(taskMode));
        lastTaskMode = taskMode;
      }
      const tools = o.getTools?.(o.context) ?? o.tools;
      const registered = new Set(tools.map((t) => t.function.name));
      // Persist steering and continuation instructions before the next network
      // request; a failed request must not restore an older user intention.
      await o.checkpoint?.(messages, usage);
      let completion;
      try {
        completion = await this.llm.complete(o.selection, messages, tools, {
          serviceTier: o.serviceTier,
          temperature: o.temperature,
          nativeSearch: !taskMode && o.nativeSearch,
          claude,
          signal: o.requestSignal?.() ?? o.context.signal,
          trace: { channel: o.context.channelId, agent: lineage, round, child: o.context.depth > 0, turn: o.context.turnId },
          onRetry: async ({ attempt, maxRetries, status, diagnostics }) => {
            const detail = failureDetail(diagnostics, status);
            await o.context.progress?.(
              `応答を再接続しています（${attempt}/${maxRetries}${detail ? `・${detail}` : ""}）。進捗は保持しています。`,
            ).catch(() => {});
          },
        });
      } catch (error) {
        if (!o.context.signal?.aborted) {
          const fresh = o.takeSteering?.() ?? [];
          if (fresh.length) {
            messages.push(...fresh);
            continue;
          }
          // Once per run: a second rejection is not about thinking blocks.
          if (claude && !stripped && error instanceof ProviderError && error.feature === "thinking_binding" && stripThinking(messages)) {
            stripped = true;
            o.onThinkingStripped?.();
            continue;
          }
        }
        throw error;
      }
      addUsage(usage, completion.usage);
      o.recordUsage?.(completion.usage);
      context = completion.usage.prompt_tokens + completion.usage.completion_tokens;
      const msg = completion.message;
      if (claude && completion.cutToolUse && nudges++ < 3) {
        // The output limit ended the response inside a tool call's arguments.
        // Nothing of it is kept: its complete calls were written expecting the
        // cut one to follow, and asking again unchanged would cut it again.
        messages.push({ role: "user", internal: true,
          content: "Your last response reached the output limit in the middle of a tool call and was discarded; none of its tool calls ran. Do the same work in smaller calls: write a long file in several steps, or run fewer commands at once." });
        continue;
      }
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length) {
        // Keep long tool-driven turns visible. The Discord transport edits one
        // shared progress message, so retries and parallel subagents do not spam.
        const status = msg.content?.trim() ? msg.content : claude ? completion.progress || statusLine(calls) : "";
        if (status) await o.context.progress?.(status);
        // Journal the whole requested batch before side effects. A crash can
        // leave unknown outcomes, which /retry must inspect instead of replay.
        await o.checkpoint?.(messages, usage);
        const results = new Serial();
        const execute = async (call: (typeof calls)[number]) => {
          let result: unknown;
          let failed = false;
          try {
            o.context.signal?.throwIfAborted();
            if (!registered.has(call.function.name))
              throw new Error(`Tool unavailable: ${call.function.name}`);
            const args = JSON.parse(call.function.arguments || "{}");
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw new Error("Arguments must be an object");
            const canonical = stableJson(args);
            const key = call.function.name + canonical;
            if (claude) {
              // Only an unbroken run of the same call is a loop. Running the
              // tests again after an edit, or reading a file again after
              // changing it, is the same call and is ordinary work.
              streak = key === previousCall ? streak + 1 : 1;
              previousCall = key;
              if (streak >= 3) throw new Error("This exact call was just made twice in a row. Use those results or change the approach.");
            } else {
              const count = (seen.get(key) ?? 0) + 1;
              seen.set(key, count);
              // Mailbox waits and listings are observations; repeating them is
              // normal while another agent works, unlike repeated side effects.
              if (count >= 3 && !/^(agents__)?(wait_agent|list_agents)$/.test(call.function.name))
                throw new Error(
                  "Repeated identical tool call blocked. Use existing results or change the approach.",
                );
            }
            // A subagent's model requests are charged to this turn, like Jev's.
            const jev = /^(?:mcp__agent__)?run_jev(?:_task)?$/.test(call.function.name) || (claude && call.function.name === "Agent");
            // A bounded Jev loop can outlive a parent completion. Forward user
            // steering cancellation so it cannot keep executing the old plan.
            const ctx = jev ? scopedContext(o.context, {
              // Nested Jev actions must attach images to the parent conversation.
              pendingImages: o.context.pendingImages ??= [],
              jevExecutions: o.context.jevExecutions ??= { count: 0 },
              signal: AbortSignal.any([
                ...(o.context.signal ? [o.context.signal] : []),
                ...(o.requestSignal ? [o.requestSignal()].filter((s): s is AbortSignal => !!s) : []),
              ]),
              recordToolUsage: (u: Usage) => {
                addUsage(usage, u);
                o.recordUsage?.(u);
              },
            }) : o.context;
            try { result = await o.execute(call.function.name, args, ctx); }
            finally { o.context.delivered ||= ctx.delivered; }
          } catch (error) {
            failed = true;
            result = claude ? (error instanceof Error ? error.message : String(error)) : {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          // Serialize result journaling, not network work. Concurrent atomic
          // renames could otherwise replace a newer checkpoint with an older one.
          await results.run(async () => {
            if (claude) {
              // Text as the tool wrote it, the failure as a flag, and images
              // inside the result they belong to. JSON-encoding a file's text
              // would hand the model escaped newlines and quotes.
              const output = result instanceof ToolOutput ? result.options : {};
              const images = [...(output.images ?? []), ...(o.context.pendingImages?.splice(0) ?? [])];
              messages.push({
                role: "tool" as const,
                tool_call_id: call.id,
                content: resultText(result),
                ...((failed || output.isError) && { is_error: true }),
                ...(images.length && { images }),
              });
            } else
              messages.push({
                role: "tool" as const,
                tool_call_id: call.id,
                content: JSON.stringify(result ?? null).slice(0, 40000),
              });
            await o.checkpoint?.(messages, usage);
          });
        };
        await runToolBatch(calls, (call) => {
          try {
            return supportsParallelTool(call.function.name, JSON.parse(call.function.arguments || "{}"));
          } catch { return false; }
        }, execute);
        if (o.context.pendingImages?.length)
          messages.push({
            role: "user", internal: true,
            content: "Images loaded by the preceding tools:",
            images: o.context.pendingImages.splice(0),
          });
        await o.checkpoint?.(messages, usage);
        if (o.shouldStop?.()) return { text: msg.content?.trim() ?? "", messages, usage, rounds: round + 1, context };
        if (round === o.maxRounds - 2)
          messages.push({
            role: "user", internal: true,
            content:
              "Finish the remaining work efficiently. Persist and deliver the result before your final reply.",
          });
        continue;
      }
      const fresh = o.takeSteering?.() ?? [];
      if (fresh.length) {
        messages.push(...fresh);
        continue;
      }
      const collaboration = await o.beforeFinal?.(msg.content?.trim() ?? "") ?? [];
      const lateSteering = o.takeSteering?.() ?? [];
      if (collaboration.length || lateSteering.length) {
        messages.push(...collaboration, ...lateSteering);
        continue;
      }
      const text = msg.content?.trim() ?? "";
      if (o.shouldStop?.()) return { text, messages, usage, rounds: round + 1, context };
      // Empty/truncated transport responses are not a candidate final answer.
      // Nothing judges semantic completion: no regexes over Japanese/English
      // delivery claims, no unconditional extra turns (#50).
      if ((!text || completion.incomplete) && nudges++ < 3) {
        messages.push({ role: "user", internal: true,
          content: "Continue the authorized task. Produce a complete user-facing answer; ask a concrete question only if blocked." });
        continue;
      }
      if (!text) throw new Error("Provider returned no user-facing answer");
      await o.checkpoint?.(messages, usage);
      return { text, messages, usage, rounds: round + 1, context };
    }
    throw new Error(
      "Agent reached the hard tool-round limit; progress has been saved for /retry",
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
